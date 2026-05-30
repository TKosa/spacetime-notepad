import { reducers } from '../../spacetime/generated';
import type { ProductType } from 'spacetimedb';
import { loadSpaceTimeConfig } from '../../spacetime/config';
import { ConnectionManager } from '../../spacetime/core/ConnectionManager';
import { ReducerClient } from '../../spacetime/core/ReducerClient';
import { SubscriptionFactory, type SubscriptionHandle, type TableLike } from '../../spacetime/core/SubscriptionFactory';
import type { SerializedStore } from './types';

export interface NotepadRepository {
  listKeys(): string[];
  load(key: string): SerializedStore | null;
  save(key: string, data: SerializedStore): Promise<void>;
  delete(key: string): Promise<void>;
  rename(oldKey: string, newKey: string): Promise<void>;
}

export interface SpacetimeSessionInfo {
  activeDocKey: string;
}

export interface NotepadUiStateSnapshot {
  expanded: number[];
  focusedNoteId: number;
  selected: number[];
}

export interface NotepadUiEvent {
  docKey: string;
  eventType: string;
  ancestry: number[];
  eventId: string;
}

export interface NotepadConnectionConfig {
  endpoint: string;
  schema: string;
}

type NotepadDocumentRow = {
  docKey: string;
  accessKey: string;
};

type NotepadEventRow = {
  eventId: string;
  docKey: string;
  eventType: string;
  ancestryJson: string;
};

type NotepadNoteRow = {
  docKey: string;
  noteId: bigint | number;
  markup: string;
  childrenJson: string;
};

function resolveReducerParams(snakeCaseName: string, camelCaseName: string): ProductType {
  const reducerMap = reducers as unknown as Record<string, { paramsType?: ProductType | undefined }>;
  const reducer = reducerMap[camelCaseName] ?? reducerMap[snakeCaseName];
  if (!reducer?.paramsType) {
    throw new Error(`Missing reducer schema for '${snakeCaseName}'.`);
  }
  return reducer.paramsType;
}

function toNumber(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function toI64(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
}

export class SpacetimeNotepadRepo implements NotepadRepository {
  private readonly reducerClient: ReducerClient;
  private readonly subscriptionFactory: SubscriptionFactory;
  private documentSubscription: SubscriptionHandle | null = null;
  private notesSubscription: SubscriptionHandle | null = null;
  private eventsSubscription: SubscriptionHandle | null = null;
  private sessionSubscription: SubscriptionHandle | null = null;
  private uiStateSubscription: SubscriptionHandle | null = null;
  private allSessionsSubscription: SubscriptionHandle | null = null;

  private readonly visibleDocKeys = new Set<string>();
  private allNoteRows: NotepadNoteRow[] = [];
  private readonly noteRowsByDoc = new Map<string, NotepadNoteRow[]>();
  private readonly eventRowsByDoc = new Map<string, NotepadEventRow[]>();
  private readonly uiStateByDoc = new Map<
    string,
    { docKey: string; expandedJson: string; focusedNoteId: bigint | number; selectedJson: string }
  >();
  private activeSessionDocKey: string | null = null;
  private readonly sessionDocListeners = new Set<(docKey: string) => void>();
  private readonly activeSessionIdentitySet = new Set<string>();
  private disposed = false;

  private constructor(
    private readonly connectionManager: ConnectionManager,
    reducerClient: ReducerClient,
    subscriptionFactory: SubscriptionFactory,
  ) {
    this.reducerClient = reducerClient;
    this.subscriptionFactory = subscriptionFactory;
  }

  static defaultConnectionConfig(): NotepadConnectionConfig {
    return SpacetimeNotepadRepo.loadNotepadSpaceTimeConfig();
  }

  static async create(configOverride?: Partial<NotepadConnectionConfig>): Promise<SpacetimeNotepadRepo> {
    const config = SpacetimeNotepadRepo.loadNotepadSpaceTimeConfig(configOverride);
    // Duplicate browser tabs can inherit sessionStorage state, including the
    // auth token. For notepad we want each tab to establish an independent
    // identity/session, so clear this tab's stored token before connecting.
    SpacetimeNotepadRepo.clearSessionAuthToken(config.endpoint, config.schema);
    const connectionManager = new ConnectionManager({ config, authTokenStorage: 'session' });
    const reducerClient = new ReducerClient(connectionManager);
    const subscriptionFactory = new SubscriptionFactory(connectionManager);
    const repo = new SpacetimeNotepadRepo(connectionManager, reducerClient, subscriptionFactory);
    await repo.initialize();
    return repo;
  }

  private static loadNotepadSpaceTimeConfig(configOverride?: Partial<NotepadConnectionConfig>) {
    const baseConfig = loadSpaceTimeConfig();
    const env = import.meta.env as Record<string, string | undefined>;
    const notepadEndpoint = env.VITE_NOTEPAD_SPACE_TIME_ENDPOINT?.trim();
    const notepadSchema = env.VITE_NOTEPAD_SPACE_TIME_SCHEMA?.trim();
    const overrideEndpoint = configOverride?.endpoint?.trim();
    const overrideSchema = configOverride?.schema?.trim();

    return {
      ...baseConfig,
      endpoint:
        overrideEndpoint && overrideEndpoint.length > 0
          ? overrideEndpoint
          : notepadEndpoint && notepadEndpoint.length > 0
            ? notepadEndpoint
            : baseConfig.endpoint,
      schema:
        overrideSchema && overrideSchema.length > 0
          ? overrideSchema
          : notepadSchema && notepadSchema.length > 0
            ? notepadSchema
            : `${baseConfig.schema}notepad`,
    };
  }

  private static clearSessionAuthToken(endpoint: string, schema: string): void {
    try {
      const key = `mmo.spacetime.auth_token.${endpoint}.${schema}`;
      window.sessionStorage.removeItem(key);
    } catch {
      // Ignore storage failures and continue with an unauthenticated connect.
    }
  }

  private async initialize(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.connectionManager.ensureConnection();

    this.documentSubscription = await this.subscriptionFactory.createArraySubscription<NotepadDocumentRow, NotepadDocumentRow>(
      {
        sql: 'SELECT * FROM notepad_documents',
        getTable: (db) => (db.notepadDocuments ?? db.notepad_documents) as TableLike<NotepadDocumentRow>,
        mapRow: (row) => row,
        sortFn: (a, b) => a.docKey.localeCompare(b.docKey),
      },
      (rows) => {
        this.visibleDocKeys.clear();
        for (const row of rows) {
          this.visibleDocKeys.add(row.docKey);
        }
        this.rebuildVisibleNoteCache();
      },
    );

    this.notesSubscription = await this.subscriptionFactory.createArraySubscription<NotepadNoteRow, NotepadNoteRow>(
      {
        sql: 'SELECT * FROM notepad_notes',
        getTable: (db) => (db.notepadNotes ?? db.notepad_notes) as TableLike<NotepadNoteRow>,
        mapRow: (row) => row,
        sortFn: (a, b) => {
          if (a.docKey !== b.docKey) {
            return a.docKey.localeCompare(b.docKey);
          }
          return toNumber(a.noteId) - toNumber(b.noteId);
        },
      },
      (rows) => {
        this.allNoteRows = rows;
        this.rebuildVisibleNoteCache();
      },
    );

    this.eventsSubscription = await this.subscriptionFactory.createArraySubscription<NotepadEventRow, NotepadEventRow>(
      {
        sql: 'SELECT * FROM notepad_events',
        getTable: (db) => (db.notepadEvents ?? db.notepad_events) as TableLike<NotepadEventRow>,
        mapRow: (row) => row,
        sortFn: (a, b) => a.eventId.localeCompare(b.eventId),
      },
      (rows) => {
        this.eventRowsByDoc.clear();
        for (const row of rows) {
          const bucket = this.eventRowsByDoc.get(row.docKey) ?? [];
          bucket.push(row);
          this.eventRowsByDoc.set(row.docKey, bucket);
        }
      },
    );

    this.sessionSubscription = await this.subscriptionFactory.createSingleRowSubscription<
      { activeDocKey: string },
      { activeDocKey: string }
    >(
      {
        sql: 'SELECT * FROM my_notepad_session',
        getTable: (db) => (db.myNotepadSession ?? db.my_notepad_session) as TableLike<{ activeDocKey: string }>,
        mapRow: (row) => row,
      },
      (row) => {
        const next = row?.activeDocKey ?? null;
        this.activeSessionDocKey = next;
        if (!next) {
          return;
        }
        for (const listener of this.sessionDocListeners) {
          listener(next);
        }
      },
    );

    this.uiStateSubscription = await this.subscriptionFactory.createArraySubscription<
      { docKey: string; expandedJson: string; focusedNoteId: bigint | number; selectedJson: string },
      { docKey: string; expandedJson: string; focusedNoteId: bigint | number; selectedJson: string }
    >(
      {
        sql: 'SELECT * FROM my_notepad_ui_state',
        getTable: (db) =>
          (db.myNotepadUiState ?? db.my_notepad_ui_state) as TableLike<{
            docKey: string;
            expandedJson: string;
            focusedNoteId: bigint | number;
            selectedJson: string;
          }>,
        mapRow: (row) => row,
        sortFn: (a, b) => a.docKey.localeCompare(b.docKey),
      },
      (rows) => {
        this.uiStateByDoc.clear();
        for (const row of rows) {
          this.uiStateByDoc.set(row.docKey, row);
        }
      },
    );

    this.allSessionsSubscription = await this.subscriptionFactory.createArraySubscription<
      { identity: unknown },
      { identity: unknown }
    >(
      {
        sql: 'SELECT * FROM notepad_sessions',
        getTable: (db) => (db.notepadSessions ?? db.notepad_sessions) as TableLike<{ identity: unknown }>,
        mapRow: (row) => row,
      },
      (rows) => {
        this.activeSessionIdentitySet.clear();
        for (const row of rows) {
          this.activeSessionIdentitySet.add(String(row.identity));
        }
      },
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.documentSubscription?.unsubscribe();
    this.documentSubscription = null;
    this.notesSubscription?.unsubscribe();
    this.notesSubscription = null;
    this.eventsSubscription?.unsubscribe();
    this.eventsSubscription = null;
    this.sessionSubscription?.unsubscribe();
    this.sessionSubscription = null;
    this.uiStateSubscription?.unsubscribe();
    this.uiStateSubscription = null;
    this.allSessionsSubscription?.unsubscribe();
    this.allSessionsSubscription = null;
    this.sessionDocListeners.clear();
    await this.connectionManager.disconnect({ skipLogout: true });
  }

  private rebuildVisibleNoteCache(): void {
    this.noteRowsByDoc.clear();
    for (const row of this.allNoteRows) {
      if (!this.visibleDocKeys.has(row.docKey)) {
        continue;
      }
      const bucket = this.noteRowsByDoc.get(row.docKey) ?? [];
      bucket.push(row);
      this.noteRowsByDoc.set(row.docKey, bucket);
    }
  }

  listKeys(): string[] {
    return Array.from(this.visibleDocKeys).sort((a, b) => a.localeCompare(b));
  }

  load(key: string): SerializedStore | null {
    const rows = this.noteRowsByDoc.get(key);
    if (!rows || rows.length === 0) {
      return null;
    }

    const notes: Record<number, { id: number; markup: string; children: number[] }> = {};
    for (const row of rows) {
      let children: number[] = [];
      try {
        children = JSON.parse(row.childrenJson) as number[];
      } catch {
        children = [];
      }
      const noteId = toNumber(row.noteId);
      notes[noteId] = {
        id: noteId,
        markup: row.markup,
        children,
      };
    }

    return {
      version: 2,
      notes,
    };
  }

  async save(key: string, data: SerializedStore): Promise<void> {
    const notesJson = JSON.stringify(data.notes);
    await this.reducerClient.callAndConfirm({
      reducerName: 'replace_notepad_document',
      paramsType: resolveReducerParams('replace_notepad_document', 'replaceNotepadDocument'),
      args: {
        docKey: key,
        notesJson,
        accessKeyForCreate: '',
      },
      failureMessage: 'Failed to save notepad document',
    });
  }

  async delete(key: string): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'delete_notepad_document',
      paramsType: resolveReducerParams('delete_notepad_document', 'deleteNotepadDocument'),
      args: { docKey: key },
      failureMessage: 'Failed to delete notepad document',
    });
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'rename_notepad_document',
      paramsType: resolveReducerParams('rename_notepad_document', 'renameNotepadDocument'),
      args: { oldDocKey: oldKey, newDocKey: newKey },
      failureMessage: 'Failed to rename notepad document',
    });
  }

  async startSession(): Promise<SpacetimeSessionInfo> {
    const previousDoc = this.activeSessionDocKey;
    await this.reducerClient.callAndConfirm({
      reducerName: 'start_notepad_session',
      paramsType: resolveReducerParams('start_notepad_session', 'startNotepadSession'),
      args: {},
      failureMessage: 'Failed to start notepad session',
    });
    const timeoutMs = 5000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const active = this.activeSessionDocKey;
      if (active && active !== previousDoc) {
        return { activeDocKey: active };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (this.activeSessionDocKey) {
      return { activeDocKey: this.activeSessionDocKey };
    }
    throw new Error('No active notepad session row returned by server');
  }

  async setSessionDocument(docKey: string): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'set_notepad_session_document',
      paramsType: resolveReducerParams('set_notepad_session_document', 'setNotepadSessionDocument'),
      args: { docKey },
      failureMessage: 'Failed to set active notepad session document',
    });
  }

  async editNoteMarkup(docKey: string, noteId: number, markup: string): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'edit_notepad_note_markup',
      paramsType: resolveReducerParams('edit_notepad_note_markup', 'editNotepadNoteMarkup'),
      args: { docKey, noteId: toI64(noteId), markup },
      failureMessage: 'Failed to edit note markup',
    });
  }

  async insertChild(docKey: string, parentNoteId: number, markup: string): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'insert_notepad_child',
      paramsType: resolveReducerParams('insert_notepad_child', 'insertNotepadChild'),
      args: { docKey, parentNoteId: toI64(parentNoteId), markup },
      failureMessage: 'Failed to insert note child',
    });
  }

  async deleteNote(docKey: string, noteId: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'delete_notepad_note',
      paramsType: resolveReducerParams('delete_notepad_note', 'deleteNotepadNote'),
      args: { docKey, noteId: toI64(noteId) },
      failureMessage: 'Failed to delete note',
    });
  }

  async moveNote(docKey: string, noteId: number, newParentId: number, index: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'move_notepad_note',
      paramsType: resolveReducerParams('move_notepad_note', 'moveNotepadNote'),
      args: {
        docKey,
        noteId: toI64(noteId),
        newParentId: toI64(newParentId),
        index: toI64(index),
      },
      failureMessage: 'Failed to move note',
    });
  }

  async expandNote(docKey: string, noteId: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'expand_notepad_note',
      paramsType: resolveReducerParams('expand_notepad_note', 'expandNotepadNote'),
      args: { docKey, noteId: toI64(noteId) },
      failureMessage: 'Failed to expand note',
    });
  }

  async collapseNote(docKey: string, noteId: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'collapse_notepad_note',
      paramsType: resolveReducerParams('collapse_notepad_note', 'collapseNotepadNote'),
      args: { docKey, noteId: toI64(noteId) },
      failureMessage: 'Failed to collapse note',
    });
  }

  async focusNote(docKey: string, noteId: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'focus_notepad_note',
      paramsType: resolveReducerParams('focus_notepad_note', 'focusNotepadNote'),
      args: { docKey, noteId: toI64(noteId) },
      failureMessage: 'Failed to focus note',
    });
  }

  async selectNote(docKey: string, noteId: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'select_notepad_note',
      paramsType: resolveReducerParams('select_notepad_note', 'selectNotepadNote'),
      args: { docKey, noteId: toI64(noteId) },
      failureMessage: 'Failed to select note',
    });
  }

  async pruneEvents(olderThanMicros: number, limit: number): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'prune_notepad_events',
      paramsType: resolveReducerParams('prune_notepad_events', 'pruneNotepadEvents'),
      args: { olderThanMicros: toI64(olderThanMicros), limit: toI64(limit) },
      failureMessage: 'Failed to prune notepad events',
    });
  }

  async saveUiState(docKey: string, state: NotepadUiStateSnapshot): Promise<void> {
    await this.reducerClient.callAndConfirm({
      reducerName: 'upsert_notepad_ui_state',
      paramsType: resolveReducerParams('upsert_notepad_ui_state', 'upsertNotepadUiState'),
      args: {
        docKey,
        expandedJson: JSON.stringify(state.expanded),
        focusedNoteId: toI64(state.focusedNoteId),
        selectedJson: JSON.stringify(state.selected),
      },
      failureMessage: 'Failed to persist notepad UI state',
    });
  }

  async loadUiState(docKey: string): Promise<NotepadUiStateSnapshot | null> {
    const row = this.uiStateByDoc.get(docKey);
    if (!row) {
      return null;
    }
    try {
      const expanded = JSON.parse(row.expandedJson) as number[];
      const selected = JSON.parse(row.selectedJson) as number[];
      return { expanded, selected, focusedNoteId: toNumber(row.focusedNoteId) };
    } catch {
      return null;
    }
  }

  getCachedUiState(docKey: string): NotepadUiStateSnapshot | null {
    const row = this.uiStateByDoc.get(docKey);
    if (!row) {
      return null;
    }
    try {
      const expanded = JSON.parse(row.expandedJson) as number[];
      const selected = JSON.parse(row.selectedJson) as number[];
      return { expanded, selected, focusedNoteId: toNumber(row.focusedNoteId) };
    } catch {
      return null;
    }
  }

  getConnectionIdentity(): string | null {
    return this.connectionManager.getIdentity();
  }

  getConnectionIdentityAlias(): string | null {
    const identity = this.getConnectionIdentity();
    if (!identity) {
      return null;
    }
    const identities = Array.from(this.activeSessionIdentitySet);
    if (!identities.includes(identity)) {
      identities.push(identity);
    }
    identities.sort((a, b) => a.localeCompare(b));
    const index = identities.indexOf(identity);
    if (index < 0) {
      return null;
    }
    return String(index + 1);
  }

  onSessionDocumentChange(listener: (docKey: string) => void): () => void {
    this.sessionDocListeners.add(listener);
    if (this.activeSessionDocKey) {
      listener(this.activeSessionDocKey);
    }
    return () => {
      this.sessionDocListeners.delete(listener);
    };
  }

  consumeUiEvents(key: string, knownEventIds: Set<string>): NotepadUiEvent[] {
    const rows = this.eventRowsByDoc.get(key) ?? [];
    const out: NotepadUiEvent[] = [];
    for (const row of rows) {
      if (knownEventIds.has(row.eventId)) {
        continue;
      }
      if (
        row.eventType !== 'expand' &&
        row.eventType !== 'collapse' &&
        row.eventType !== 'focus' &&
        row.eventType !== 'select'
      ) {
        continue;
      }
      let ancestry: number[] = [];
      try {
        ancestry = JSON.parse(row.ancestryJson) as number[];
      } catch {
        ancestry = [];
      }
      if (ancestry.length === 0) {
        continue;
      }
      out.push({ docKey: row.docKey, eventType: row.eventType, ancestry, eventId: row.eventId });
    }
    return out;
  }
}
