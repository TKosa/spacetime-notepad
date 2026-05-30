import { NoteStore } from './noteStore';
import { LocalStorageRepo } from './localStorageRepo';
import { instructions } from './instructions';
import { SpacetimeNotepadRepo, type NotepadConnectionConfig, type NotepadRepository } from './spacetimeRepo';

type VisibleItem = {
  noteId: number;
  depth: number;
  parentId: number | null;
  isReference: boolean;
  instanceKey: string;
};

const AUTO_SAVE_DELAY_MS = 2 * 60 * 1000;
const STORAGE_MODE_KEY = 'tnp-storage-mode';
const SPACETIME_ENDPOINT_KEY = 'tnp-spacetime-endpoint';
const SPACETIME_SCHEMA_KEY = 'tnp-spacetime-schema';
const SPACETIME_TARGETS_KEY = 'tnp-spacetime-targets';
const SPACETIME_TARGET_SELECTED_KEY = 'tnp-spacetime-target-selected';
const LIVE_SYNC_MS = 1000;
const UI_STATE_SYNC_MS = 1500;
const LAST_SPACETIME_DOC_KEY = 'tnp-last-spacetime-doc';

type SpacetimeTarget = {
  id: string;
  name: string;
  endpoint: string;
  schema: string;
  isDefault?: boolean;
};

export class NotepadApp {
  private readonly root: HTMLElement;
  private readonly store = new NoteStore();
  private readonly localRepo: NotepadRepository = new LocalStorageRepo();
  private spacetimeRepo: NotepadRepository | null = null;
  private repo: NotepadRepository = this.localRepo;
  private storageMode: 'local' | 'spacetime' = 'local';
  private readonly expanded = new Set<number>([0]);
  private readonly referencesByNote = new Map<number, Set<number>>();
  private readonly expandedReferenceInstances = new Set<string>();

  private focusedId = 0;
  private focusedInstanceKey = 'root';
  private editingId: number | null = null;
  private selectedIds = new Set<number>();
  private selectedInstanceKeys = new Set<string>();
  private copiedIds: number[] = [];
  private copyMode: 'copy' | 'cut' = 'copy';
  private dirty = false;
  private currentName = 'Untitled';
  private truncateNotes = true;
  private disableAutoSave = false;

  private listEl!: HTMLElement;
  private saveTimer: number | null = null;
  private fileMenuOpen = false;
  private settingsMenuOpen = false;
  private databaseMenuOpen = false;
  private helpMenuOpen = false;
  private liveSyncTimer: number | null = null;
  private uiStateSyncTimer: number | null = null;
  private currentDocFingerprint = '';
  private readonly seenUiEventIds = new Set<string>();
  private uiStateFingerprint = '';
  private stopSessionDocListener: (() => void) | null = null;
  private identityLabel = '';
  private spacetimeConnectStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private spacetimeConnectMessage = '';
  private spacetimeTargets: SpacetimeTarget[] = [];
  private selectedSpacetimeTargetId = '';
  private draftSpacetimeTargetName = '';
  private draftSpacetimeEndpoint = '';
  private draftSpacetimeSchema = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.storageMode = this.loadStorageModePreference();
    if (this.storageMode === 'spacetime') {
      // Spacetime connection is now explicit via the Connect action.
      this.storageMode = 'local';
      this.persistStorageModePreference('local');
    }
    this.loadSpacetimeTargetsPreference();
    this.bootstrapInstructions();
    this.renderShell();
    this.renderTree();
    this.attachGlobalEvents();
    this.markClean();
  }

  private defaultSpacetimeTarget(): SpacetimeTarget {
    const defaults = SpacetimeNotepadRepo.defaultConnectionConfig();
    return {
      id: this.makeTargetId(defaults.endpoint, defaults.schema),
      name: 'Default',
      endpoint: this.normalizeEndpoint(defaults.endpoint),
      schema: defaults.schema.trim(),
      isDefault: true,
    };
  }

  private makeTargetId(endpoint: string, schema: string): string {
    return `${endpoint.trim().toLowerCase()}|${schema.trim().toLowerCase()}`;
  }

  private normalizeEndpoint(endpoint: string): string {
    return endpoint.trim().replace(/\/+$/, '');
  }

  private loadSpacetimeTargetsPreference(): void {
    const fallback = this.defaultSpacetimeTarget();
    let loadedTargets: SpacetimeTarget[] = [];
    const raw = window.localStorage.getItem(SPACETIME_TARGETS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as SpacetimeTarget[];
        if (Array.isArray(parsed)) {
          loadedTargets = parsed
            .map((target) => ({
              id: this.makeTargetId(String(target.endpoint ?? ''), String(target.schema ?? '')),
              name: String(target.name ?? '').trim() || 'Custom',
              endpoint: this.normalizeEndpoint(String(target.endpoint ?? '')),
              schema: String(target.schema ?? '').trim(),
              isDefault: false,
            }))
            .filter((target) => target.endpoint.length > 0 && target.schema.length > 0);
        }
      } catch {
        loadedTargets = [];
      }
    }

    const legacyEndpoint = window.localStorage.getItem(SPACETIME_ENDPOINT_KEY)?.trim() ?? '';
    const legacySchema = window.localStorage.getItem(SPACETIME_SCHEMA_KEY)?.trim() ?? '';
    if (legacyEndpoint.length > 0 && legacySchema.length > 0) {
      loadedTargets.push({
        id: this.makeTargetId(legacyEndpoint, legacySchema),
        name: 'Legacy',
        endpoint: this.normalizeEndpoint(legacyEndpoint),
        schema: legacySchema,
      });
    }

    const byId = new Map<string, SpacetimeTarget>();
    byId.set(fallback.id, fallback);
    for (const target of loadedTargets) {
      byId.set(target.id, target);
    }

    this.spacetimeTargets = Array.from(byId.values());
    this.selectedSpacetimeTargetId = window.localStorage.getItem(SPACETIME_TARGET_SELECTED_KEY)?.trim() ?? fallback.id;
    if (!this.spacetimeTargets.some((target) => target.id === this.selectedSpacetimeTargetId)) {
      this.selectedSpacetimeTargetId = fallback.id;
    }

    this.draftSpacetimeTargetName = '';
    this.draftSpacetimeEndpoint = fallback.endpoint;
    this.draftSpacetimeSchema = fallback.schema;
    this.persistSpacetimeTargetsPreference();
  }

  private persistSpacetimeTargetsPreference(): void {
    window.localStorage.setItem(SPACETIME_TARGETS_KEY, JSON.stringify(this.spacetimeTargets));
    window.localStorage.setItem(SPACETIME_TARGET_SELECTED_KEY, this.selectedSpacetimeTargetId);
  }

  private selectedSpacetimeTarget(): SpacetimeTarget | null {
    return this.spacetimeTargets.find((target) => target.id === this.selectedSpacetimeTargetId) ?? null;
  }

  private setSelectedSpacetimeTarget(id: string): void {
    if (!this.spacetimeTargets.some((target) => target.id === id)) {
      return;
    }
    this.selectedSpacetimeTargetId = id;
    this.persistSpacetimeTargetsPreference();
  }

  private async enableSpacetimePersistence(config: NotepadConnectionConfig): Promise<boolean> {
    this.spacetimeConnectStatus = 'connecting';
    this.spacetimeConnectMessage = `Connecting to ${config.endpoint} (${config.schema})...`;
    this.renderShell();
    this.renderTree();
    try {
      this.spacetimeRepo = await SpacetimeNotepadRepo.create(config);
      this.stopSessionDocListener?.();
      this.stopSessionDocListener = this.spacetimeRepo.onSessionDocumentChange((docKey) => {
        if (this.storageMode !== 'spacetime') {
          return;
        }
        this.applyAuthoritativeSessionDocument(docKey);
      });
      if (this.storageMode === 'spacetime') {
        this.repo = this.spacetimeRepo;
        await this.initializeSpacetimeSessionDocument();
      }
      const alias = this.spacetimeRepo.getConnectionIdentityAlias();
      this.identityLabel = alias ?? '';
      this.spacetimeConnectStatus = 'connected';
      this.spacetimeConnectMessage = `Connected to ${config.endpoint} (${config.schema})`;
      this.renderShell();
      this.renderTree();
      this.ensureLiveSyncTimer();
      return true;
    } catch {
      // Keep localStorage persistence when Spacetime is unavailable or unauthenticated.
      this.spacetimeRepo = null;
      this.identityLabel = '';
      this.repo = this.localRepo;
      this.stopSessionDocListener?.();
      this.stopSessionDocListener = null;
      this.spacetimeConnectStatus = 'error';
      this.spacetimeConnectMessage = `Failed to connect to ${config.endpoint} (${config.schema})`;
      if (this.storageMode === 'spacetime') {
        this.storageMode = 'local';
        this.persistStorageModePreference('local');
      }
      this.renderShell();
      this.renderTree();
      return false;
    }
  }

  private loadStorageModePreference(): 'local' | 'spacetime' {
    const raw = window.localStorage.getItem(STORAGE_MODE_KEY);
    return raw === 'spacetime' ? 'spacetime' : 'local';
  }

  private persistStorageModePreference(mode: 'local' | 'spacetime'): void {
    window.localStorage.setItem(STORAGE_MODE_KEY, mode);
  }

  private bootstrapInstructions(): void {
    const raw = window.localStorage.getItem('visitCount');
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    const visitCount = Number.isNaN(parsed) ? 1 : parsed + 1;
    window.localStorage.setItem('visitCount', String(visitCount));
    if (visitCount <= 5) {
      this.store.loadFromJSON(instructions);
      this.expanded.add(1);
    }
  }

  private renderShell(): void {
    const saveLabel = this.storageMode === 'spacetime' ? 'Save to SpacetimeDB' : 'Save in browser';
    const loadLabel = this.storageMode === 'spacetime' ? 'Load from SpacetimeDB' : 'Load from browser';
    const deleteLabel = this.storageMode === 'spacetime' ? 'Delete from SpacetimeDB' : 'Delete saved file';
    const modeLabel = this.storageMode === 'spacetime' ? 'SpacetimeDB' : 'Local';

    const identityBadge =
      this.storageMode === 'spacetime' && this.identityLabel
        ? `<div class="tnp-identity-badge">Tab Session: ${this.identityLabel}</div>`
        : '';

    this.root.innerHTML = `
      <main class="tnp-main">
        <div class="tnp-help-overlay ${this.helpMenuOpen ? '' : 'hidden'}" data-role="help-overlay">
          <div class="tnp-help-panel" data-role="help-panel">
            <div class="tnp-help-title">Controls</div>
            <table class="tnp-help-table">
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                ${this.buildHelpRowsHtml()}
              </tbody>
            </table>
          </div>
        </div>
        <header class="tnp-menubar">
          <div class="tnp-dropdown">
            <button class="tnp-dropdown-button" data-action="toggle-file">File</button>
            <div class="tnp-dropdown-content ${this.fileMenuOpen ? '' : 'hidden'}" data-role="file-menu">
              <button data-action="new-document">New Document</button>
              <button data-action="download">Download to Computer</button>
              <button data-action="upload">Upload from Computer</button>
              <input data-role="upload-input" type="file" accept=".tnp" hidden />
              <button data-action="save">${saveLabel}</button>
              <button data-action="rename">Rename</button>
              <button data-action="load">${loadLabel}</button>
              <button data-action="delete">${deleteLabel}</button>
            </div>
          </div>
          <div class="tnp-dropdown">
            <button class="tnp-dropdown-button" data-action="toggle-settings">Settings</button>
            <div class="tnp-dropdown-content ${this.settingsMenuOpen ? '' : 'hidden'}" data-role="settings-menu">
              <label>
                <input data-role="truncate" type="checkbox" checked />
                Truncate notes
              </label>
              <label>
                <input data-role="autosave" type="checkbox" />
                Disable Auto-save
              </label>
            </div>
          </div>
          <div class="tnp-dropdown">
            <button class="tnp-dropdown-button" data-action="toggle-database">Database</button>
            <div class="tnp-dropdown-content ${this.databaseMenuOpen ? '' : 'hidden'}" data-role="database-menu">
              <label class="tnp-storage-mode-row">
                Storage mode
                <select data-role="storage-mode">
                  <option value="local" ${this.storageMode === 'local' ? 'selected' : ''}>Local</option>
                  <option value="spacetime" ${this.storageMode === 'spacetime' ? 'selected' : ''}>SpacetimeDB</option>
                </select>
              </label>
              <label class="tnp-storage-mode-row">
                Saved target
                <select data-role="spacetime-target">
                  ${this.spacetimeTargets
                    .map(
                      (target) =>
                        `<option value="${this.escapeHtmlAttr(target.id)}" ${target.id === this.selectedSpacetimeTargetId ? 'selected' : ''}>${this.escapeHtmlText(`${target.name} (${target.endpoint} / ${target.schema})`)}</option>`,
                    )
                    .join('')}
                </select>
              </label>
              <div class="tnp-target-actions">
                <button data-action="connect-spacetime" class="tnp-connect-btn">Connect</button>
                <button data-action="remove-spacetime-target" class="tnp-connect-btn">Remove</button>
              </div>
              <label class="tnp-storage-mode-row">
                New target name
                <input data-role="new-spacetime-name" type="text" value="${this.escapeHtmlAttr(this.draftSpacetimeTargetName)}" placeholder="Local Notepad" />
              </label>
              <label class="tnp-storage-mode-row">
                New endpoint
                <input data-role="new-spacetime-endpoint" type="text" value="${this.escapeHtmlAttr(this.draftSpacetimeEndpoint)}" placeholder="http://127.0.0.1:3100" />
              </label>
              <label class="tnp-storage-mode-row">
                New schema
                <input data-role="new-spacetime-schema" type="text" value="${this.escapeHtmlAttr(this.draftSpacetimeSchema)}" placeholder="mmonotepad" />
              </label>
              <button data-action="test-save-spacetime-target" class="tnp-connect-btn">Test &amp; Save</button>
              <div class="tnp-connect-status" data-connect-state="${this.spacetimeConnectStatus}">${this.spacetimeConnectMessage || 'Not connected'}</div>
            </div>
          </div>
          <div class="tnp-header-right">
            <div class="tnp-mode-badge">Mode: ${modeLabel}</div>
            ${identityBadge}
            <button class="tnp-help-fab" data-action="toggle-help" title="Help">${this.helpMenuOpen ? 'X' : '?'}</button>
          </div>
        </header>
        <section class="tnp-body">
          <div class="tnp-remote-panel ${this.storageMode === 'spacetime' ? '' : 'hidden'}">
            <input data-role="remote-note-id" type="number" placeholder="note id" />
            <input data-role="remote-parent-id" type="number" placeholder="parent id" />
            <input data-role="remote-new-parent-id" type="number" placeholder="new parent" />
            <input data-role="remote-index" type="number" placeholder="index" />
            <input data-role="remote-markup" type="text" placeholder="markup text" />
            <input data-role="remote-prune-mins" type="number" placeholder="prune mins" value="60" />
            <button data-action="remote-expand">Expand</button>
            <button data-action="remote-collapse">Collapse</button>
            <button data-action="remote-focus">Focus</button>
            <button data-action="remote-select">Select</button>
            <button data-action="remote-edit">Edit</button>
            <button data-action="remote-insert">Insert Child</button>
            <button data-action="remote-delete">Delete</button>
            <button data-action="remote-move">Move</button>
            <button data-action="remote-prune">Prune Events</button>
          </div>
          <div id="notepad" class="tnp-tree" data-role="tree"></div>
        </section>
      </main>
    `;

    this.listEl = this.root.querySelector<HTMLElement>('[data-role="tree"]') as HTMLElement;
    this.listEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.tnp-row')) {
        this.focusRoot(event.ctrlKey || event.metaKey);
      }
    });

    this.root.querySelector<HTMLButtonElement>('[data-action="toggle-file"]')?.addEventListener('click', () => {
      this.fileMenuOpen = !this.fileMenuOpen;
      this.settingsMenuOpen = false;
      this.databaseMenuOpen = false;
      this.renderShell();
      this.renderTree();
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="toggle-settings"]')?.addEventListener('click', () => {
      this.settingsMenuOpen = !this.settingsMenuOpen;
      this.fileMenuOpen = false;
      this.databaseMenuOpen = false;
      this.renderShell();
      this.renderTree();
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="toggle-database"]')?.addEventListener('click', () => {
      this.databaseMenuOpen = !this.databaseMenuOpen;
      this.fileMenuOpen = false;
      this.settingsMenuOpen = false;
      this.renderShell();
      this.renderTree();
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="toggle-help"]')?.addEventListener('click', () => {
      this.helpMenuOpen = !this.helpMenuOpen;
      this.renderShell();
      this.renderTree();
    });
    this.root.querySelector<HTMLElement>('[data-role="help-overlay"]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        this.helpMenuOpen = false;
        this.renderShell();
        this.renderTree();
      }
    });

    this.root.querySelector<HTMLButtonElement>('[data-action="new-document"]')?.addEventListener('click', () => {
      void this.createNewDocument();
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="download"]')?.addEventListener('click', () => this.download());
    this.root.querySelector<HTMLButtonElement>('[data-action="upload"]')?.addEventListener('click', () => {
      this.root.querySelector<HTMLInputElement>('[data-role="upload-input"]')?.click();
    });
    this.root.querySelector<HTMLInputElement>('[data-role="upload-input"]')?.addEventListener('change', async (e) => {
      const input = e.currentTarget as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      for (const f of files) {
        await this.uploadFile(f);
      }
      input.value = '';
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', () => {
      void this.persistCurrentDocument(this.currentName);
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="rename"]')?.addEventListener('click', () => this.promptAndRename());
    this.root.querySelector<HTMLButtonElement>('[data-action="load"]')?.addEventListener('click', () => this.loadPrompt());
    this.root.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', () => this.deletePrompt());

    this.root.querySelector<HTMLInputElement>('[data-role="truncate"]')?.addEventListener('change', (e) => {
      this.truncateNotes = (e.currentTarget as HTMLInputElement).checked;
      this.renderTree();
    });
    this.root.querySelector<HTMLInputElement>('[data-role="autosave"]')?.addEventListener('change', (e) => {
      this.disableAutoSave = (e.currentTarget as HTMLInputElement).checked;
    });
    this.root.querySelector<HTMLSelectElement>('[data-role="storage-mode"]')?.addEventListener('change', (e) => {
      const selected = (e.currentTarget as HTMLSelectElement).value as 'local' | 'spacetime';
      if (selected === 'spacetime') {
        void this.connectSpacetime({ switchModeOnSuccess: true });
      } else {
        this.setStorageMode('local');
      }
    });
    this.root.querySelector<HTMLSelectElement>('[data-role="spacetime-target"]')?.addEventListener('change', (e) => {
      this.setSelectedSpacetimeTarget((e.currentTarget as HTMLSelectElement).value);
    });
    this.root.querySelector<HTMLInputElement>('[data-role="new-spacetime-name"]')?.addEventListener('change', (e) => {
      this.draftSpacetimeTargetName = (e.currentTarget as HTMLInputElement).value.trim();
    });
    this.root.querySelector<HTMLInputElement>('[data-role="new-spacetime-endpoint"]')?.addEventListener('change', (e) => {
      this.draftSpacetimeEndpoint = (e.currentTarget as HTMLInputElement).value.trim();
    });
    this.root.querySelector<HTMLInputElement>('[data-role="new-spacetime-schema"]')?.addEventListener('change', (e) => {
      this.draftSpacetimeSchema = (e.currentTarget as HTMLInputElement).value.trim();
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="connect-spacetime"]')?.addEventListener('click', () => {
      void this.connectSpacetime({ switchModeOnSuccess: false });
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remove-spacetime-target"]')?.addEventListener('click', () => {
      this.removeSelectedSpacetimeTarget();
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="test-save-spacetime-target"]')?.addEventListener('click', () => {
      void this.testAndSaveTarget();
    });
    this.attachRemotePanelEvents();
  }

  private async connectSpacetime(options: { switchModeOnSuccess: boolean }): Promise<void> {
    const target = this.selectedSpacetimeTarget();
    if (!target) {
      this.spacetimeConnectStatus = 'error';
      this.spacetimeConnectMessage = 'Select a saved target first.';
      this.renderShell();
      this.renderTree();
      return;
    }

    const connected = await this.enableSpacetimePersistence({
      endpoint: target.endpoint,
      schema: target.schema,
    });
    if (!connected) {
      if (options.switchModeOnSuccess) {
        this.storageMode = 'local';
        this.persistStorageModePreference('local');
      }
      return;
    }
    if (options.switchModeOnSuccess) {
      this.setStorageMode('spacetime');
    }
  }

  private async testAndSaveTarget(): Promise<void> {
    const name = (this.root.querySelector<HTMLInputElement>('[data-role="new-spacetime-name"]')?.value ?? this.draftSpacetimeTargetName).trim();
    const endpoint = this.normalizeEndpoint(
      (this.root.querySelector<HTMLInputElement>('[data-role="new-spacetime-endpoint"]')?.value ?? this.draftSpacetimeEndpoint).trim(),
    );
    const schema = (this.root.querySelector<HTMLInputElement>('[data-role="new-spacetime-schema"]')?.value ?? this.draftSpacetimeSchema).trim();
    this.draftSpacetimeTargetName = name;
    this.draftSpacetimeEndpoint = endpoint;
    this.draftSpacetimeSchema = schema;

    if (!endpoint || !schema) {
      this.spacetimeConnectStatus = 'error';
      this.spacetimeConnectMessage = 'New target endpoint and schema are required.';
      this.renderShell();
      this.renderTree();
      return;
    }

    this.spacetimeConnectStatus = 'connecting';
    this.spacetimeConnectMessage = `Testing ${endpoint} (${schema})...`;
    this.renderShell();
    this.renderTree();
    try {
      const testRepo = await SpacetimeNotepadRepo.create({ endpoint, schema });
      await testRepo.dispose();
    } catch {
      this.spacetimeConnectStatus = 'error';
      this.spacetimeConnectMessage = `Test failed for ${endpoint} (${schema})`;
      this.renderShell();
      this.renderTree();
      return;
    }

    const targetId = this.makeTargetId(endpoint, schema);
    const existing = this.spacetimeTargets.find((target) => target.id === targetId);
    if (existing) {
      existing.name = name || existing.name;
      existing.endpoint = endpoint;
      existing.schema = schema;
    } else {
      this.spacetimeTargets.push({
        id: targetId,
        name: name || 'Custom',
        endpoint,
        schema,
      });
    }
    this.selectedSpacetimeTargetId = targetId;
    this.persistSpacetimeTargetsPreference();
    this.spacetimeConnectStatus = 'connected';
    this.spacetimeConnectMessage = `Saved target ${endpoint} (${schema})`;
    this.renderShell();
    this.renderTree();
  }

  private removeSelectedSpacetimeTarget(): void {
    const target = this.selectedSpacetimeTarget();
    if (!target) return;
    if (target.isDefault) {
      this.spacetimeConnectStatus = 'error';
      this.spacetimeConnectMessage = 'Default target cannot be removed.';
      this.renderShell();
      this.renderTree();
      return;
    }
    this.spacetimeTargets = this.spacetimeTargets.filter((item) => item.id !== target.id);
    const fallback = this.defaultSpacetimeTarget();
    this.selectedSpacetimeTargetId = this.spacetimeTargets[0]?.id ?? fallback.id;
    if (this.spacetimeTargets.length === 0) {
      this.spacetimeTargets = [fallback];
    }
    this.persistSpacetimeTargetsPreference();
    this.spacetimeConnectStatus = 'disconnected';
    this.spacetimeConnectMessage = `Removed target ${target.name}.`;
    this.renderShell();
    this.renderTree();
  }

  private shortenIdentity(identity: string): string {
    const trimmed = identity.trim();
    if (trimmed.length <= 18) {
      return trimmed;
    }
    return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
  }

  private escapeHtmlAttr(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private escapeHtmlText(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private attachRemotePanelEvents(): void {
    const withRepo = (fn: (repo: SpacetimeNotepadRepo) => Promise<void>) => {
      if (!(this.spacetimeRepo instanceof SpacetimeNotepadRepo) || this.storageMode !== 'spacetime') {
        window.alert('SpacetimeDB mode is required.');
        return;
      }
      void fn(this.spacetimeRepo).catch((error) => {
        const message = error instanceof Error ? error.message : 'Remote action failed';
        window.alert(message);
      });
    };

    const numberFrom = (role: string, fallback = 0): number => {
      const raw = this.root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)?.value ?? '';
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const textFrom = (role: string): string =>
      this.root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)?.value ?? '';

    this.root.querySelector<HTMLButtonElement>('[data-action="remote-expand"]')?.addEventListener('click', () => {
      withRepo(async (repo) => repo.expandNote(this.currentName, numberFrom('remote-note-id', this.focusedId)));
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-collapse"]')?.addEventListener('click', () => {
      withRepo(async (repo) => repo.collapseNote(this.currentName, numberFrom('remote-note-id', this.focusedId)));
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-focus"]')?.addEventListener('click', () => {
      withRepo(async (repo) => repo.focusNote(this.currentName, numberFrom('remote-note-id', this.focusedId)));
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-select"]')?.addEventListener('click', () => {
      withRepo(async (repo) => repo.selectNote(this.currentName, numberFrom('remote-note-id', this.focusedId)));
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-edit"]')?.addEventListener('click', () => {
      withRepo(async (repo) =>
        repo.editNoteMarkup(this.currentName, numberFrom('remote-note-id', this.focusedId), textFrom('remote-markup')),
      );
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-insert"]')?.addEventListener('click', () => {
      withRepo(async (repo) =>
        repo.insertChild(this.currentName, numberFrom('remote-parent-id', this.focusedId), textFrom('remote-markup')),
      );
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-delete"]')?.addEventListener('click', () => {
      withRepo(async (repo) => repo.deleteNote(this.currentName, numberFrom('remote-note-id', this.focusedId)));
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-move"]')?.addEventListener('click', () => {
      withRepo(async (repo) =>
        repo.moveNote(
          this.currentName,
          numberFrom('remote-note-id', this.focusedId),
          numberFrom('remote-new-parent-id', 0),
          numberFrom('remote-index', 0),
        ),
      );
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="remote-prune"]')?.addEventListener('click', () => {
      withRepo(async (repo) => {
        const mins = numberFrom('remote-prune-mins', 60);
        await repo.pruneEvents(mins * 60 * 1_000_000, 500);
      });
    });
  }

  private setStorageMode(mode: 'local' | 'spacetime'): void {
    if (mode === 'spacetime' && !this.spacetimeRepo) {
      this.spacetimeConnectStatus = 'error';
      this.spacetimeConnectMessage = 'Connect to a saved Spacetime target first.';
      this.storageMode = 'local';
      this.repo = this.localRepo;
      this.renderShell();
      this.renderTree();
      return;
    }

    this.storageMode = mode;
    this.persistStorageModePreference(mode);
    this.repo = mode === 'spacetime' ? (this.spacetimeRepo as NotepadRepository) : this.localRepo;
    if (mode === 'spacetime') {
      void this.initializeSpacetimeSessionDocument();
    }
    this.renderShell();
    this.renderTree();
    this.ensureLiveSyncTimer();
  }

  private async initializeSpacetimeSessionDocument(options?: { preferLastDoc?: boolean }): Promise<void> {
    if (!(this.spacetimeRepo instanceof SpacetimeNotepadRepo)) {
      return;
    }
    const preferLastDoc = options?.preferLastDoc ?? true;
    const lastDoc = window.localStorage.getItem(LAST_SPACETIME_DOC_KEY);
    let activeDoc = '';
    if (preferLastDoc && lastDoc && this.repo.listKeys().includes(lastDoc)) {
      try {
        await this.spacetimeRepo.setSessionDocument(lastDoc);
        activeDoc = lastDoc;
      } catch {
        activeDoc = '';
      }
    }
    if (!activeDoc) {
      const session = await this.spacetimeRepo.startSession();
      activeDoc = session.activeDocKey;
    }
    const data = this.repo.load(activeDoc);
    if (data) {
      this.store.reset();
      this.store.loadFromJSON(data);
    } else {
      this.store.reset();
    }
    this.currentName = activeDoc;
    this.focusedId = 0;
    this.selectedIds = new Set<number>();
    this.selectedInstanceKeys = new Set<string>();
    this.editingId = null;
    this.expanded.clear();
    this.expanded.add(0);
    this.markClean();
    this.currentDocFingerprint = JSON.stringify(this.store.toSerializable().notes);
    this.seenUiEventIds.clear();
    await this.restoreUiStateFromBackend();
    this.uiStateFingerprint = this.buildUiStateFingerprint();
    this.renderShell();
    this.renderTree();
  }

  private applyAuthoritativeSessionDocument(docKey: string): void {
    window.localStorage.setItem(LAST_SPACETIME_DOC_KEY, docKey);
    if (this.currentName === docKey) {
      return;
    }
    const data = this.repo.load(docKey);
    this.currentName = docKey;
    if (data) {
      this.store.reset();
      this.store.loadFromJSON(data);
      this.focusedId = 0;
      this.selectedIds = new Set<number>();
      this.selectedInstanceKeys = new Set<string>();
      this.editingId = null;
      this.expanded.clear();
      this.expanded.add(0);
      this.markClean();
      this.currentDocFingerprint = JSON.stringify(data.notes);
      this.applyUiStateFromBackend();
      this.uiStateFingerprint = this.buildUiStateFingerprint();
    } else {
      this.focusedId = 0;
      this.selectedIds = new Set<number>();
      this.selectedInstanceKeys = new Set<string>();
      this.editingId = null;
      this.expanded.clear();
      this.expanded.add(0);
      this.markClean();
      this.currentDocFingerprint = JSON.stringify(this.store.toSerializable().notes);
      this.uiStateFingerprint = this.buildUiStateFingerprint();
    }
    this.renderTree();
  }

  private async createNewDocument(): Promise<void> {
    if (this.storageMode === 'spacetime') {
      await this.initializeSpacetimeSessionDocument({ preferLastDoc: false });
      return;
    }

    this.store.reset();
    this.currentName = 'Untitled';
    this.focusedId = 0;
    this.selectedIds = new Set<number>();
    this.selectedInstanceKeys = new Set<string>();
    this.editingId = null;
    this.expanded.clear();
    this.expanded.add(0);
    this.markClean();
    this.currentDocFingerprint = JSON.stringify(this.store.toSerializable().notes);
    this.uiStateFingerprint = this.buildUiStateFingerprint();
    this.renderShell();
    this.renderTree();
  }

  private async restoreUiStateFromBackend(): Promise<void> {
    if (!(this.spacetimeRepo instanceof SpacetimeNotepadRepo)) {
      return;
    }
    const state = await this.spacetimeRepo.loadUiState(this.currentName);
    if (!state) {
      return;
    }
    this.expanded.clear();
    for (const noteId of state.expanded) {
      this.expanded.add(noteId);
    }
    this.expanded.add(0);
    this.focusedId = state.focusedNoteId;
    this.selectedIds = new Set<number>(state.selected);
    this.selectedInstanceKeys = new Set<string>();
  }

  private ensureLiveSyncTimer(): void {
    if (this.liveSyncTimer !== null) {
      window.clearInterval(this.liveSyncTimer);
      this.liveSyncTimer = null;
    }
    this.liveSyncTimer = window.setInterval(() => this.syncFromBackendIfNeeded(), LIVE_SYNC_MS);
    if (this.uiStateSyncTimer !== null) {
      window.clearInterval(this.uiStateSyncTimer);
      this.uiStateSyncTimer = null;
    }
    this.uiStateSyncTimer = window.setInterval(() => {
      void this.syncUiStateToBackendIfNeeded();
    }, UI_STATE_SYNC_MS);
  }

  private syncFromBackendIfNeeded(): void {
    if (this.storageMode !== 'spacetime') {
      return;
    }
    if (this.spacetimeRepo instanceof SpacetimeNotepadRepo) {
      const nextAlias = this.spacetimeRepo.getConnectionIdentityAlias() ?? '';
      if (nextAlias !== this.identityLabel) {
        this.identityLabel = nextAlias;
        this.renderShell();
        this.renderTree();
      }
    }
    this.applyUiEvents();
    if (this.dirty || this.editingId !== null) {
      return;
    }
    const data = this.repo.load(this.currentName);
    if (!data) {
      return;
    }
    const nextFingerprint = JSON.stringify(data.notes);
    if (nextFingerprint === this.currentDocFingerprint) {
      return;
    }

    this.store.reset();
    this.store.loadFromJSON(data);
    this.editingId = null;
    this.currentDocFingerprint = nextFingerprint;
    this.applyUiStateFromBackend();
    this.uiStateFingerprint = this.buildUiStateFingerprint();
    this.renderTree();
  }

  private applyUiStateFromBackend(): void {
    if (!(this.spacetimeRepo instanceof SpacetimeNotepadRepo)) {
      return;
    }
    const state = this.spacetimeRepo.getCachedUiState(this.currentName);
    if (!state) {
      return;
    }
    const nextExpanded = new Set<number>(state.expanded.filter((id) => id === 0 || this.store.getNote(id)));
    nextExpanded.add(0);
    const nextSelected = new Set<number>(state.selected.filter((id) => this.store.getNote(id)));
    const nextFocused = this.store.getNote(state.focusedNoteId) ? state.focusedNoteId : 0;

    let changed = false;
    if (this.focusedId !== nextFocused) {
      this.focusedId = nextFocused;
      changed = true;
    }
    if (this.selectedIds.size !== nextSelected.size || Array.from(nextSelected).some((id) => !this.selectedIds.has(id))) {
      this.selectedIds = nextSelected;
      changed = true;
    }
    if (this.expanded.size !== nextExpanded.size || Array.from(nextExpanded).some((id) => !this.expanded.has(id))) {
      this.expanded.clear();
      for (const id of nextExpanded) {
        this.expanded.add(id);
      }
      changed = true;
    }

    if (changed) {
      this.uiStateFingerprint = this.buildUiStateFingerprint();
      this.renderTree();
    }
  }

  private buildUiStateFingerprint(): string {
    const expanded = Array.from(this.expanded).sort((a, b) => a - b);
    const selected = Array.from(this.selectedIds).sort((a, b) => a - b);
    return JSON.stringify({
      expanded,
      focusedId: this.focusedId,
      selected,
    });
  }

  private async syncUiStateToBackendIfNeeded(): Promise<void> {
    if (this.storageMode !== 'spacetime') {
      return;
    }
    if (!(this.spacetimeRepo instanceof SpacetimeNotepadRepo)) {
      return;
    }
    const validExpanded = Array.from(this.expanded).filter((id) => id === 0 || this.store.getNote(id) !== null);
    const validSelected = Array.from(this.selectedIds).filter((id) => this.store.getNote(id) !== null);
    const validFocusedId = this.store.getNote(this.focusedId) ? this.focusedId : 0;
    if (validFocusedId !== this.focusedId) {
      this.focusedId = validFocusedId;
    }
    if (validSelected.length !== this.selectedIds.size || validSelected.some((id) => !this.selectedIds.has(id))) {
      this.selectedIds = new Set<number>(validSelected);
      this.selectedInstanceKeys = new Set<string>();
    }
    if (validExpanded.length !== this.expanded.size || validExpanded.some((id) => !this.expanded.has(id))) {
      this.expanded.clear();
      for (const id of validExpanded) {
        this.expanded.add(id);
      }
    }

    const nextFingerprint = this.buildUiStateFingerprint();
    if (nextFingerprint === this.uiStateFingerprint) {
      return;
    }
    await this.spacetimeRepo.saveUiState(this.currentName, {
      expanded: validExpanded,
      focusedNoteId: validFocusedId,
      selected: validSelected,
    });
    this.uiStateFingerprint = nextFingerprint;
  }

  private applyUiEvents(): void {
    if (!(this.spacetimeRepo instanceof SpacetimeNotepadRepo)) {
      return;
    }
    const events = this.spacetimeRepo.consumeUiEvents(this.currentName, this.seenUiEventIds);
    if (events.length === 0) {
      return;
    }
    let changed = false;
    for (const event of events) {
      this.seenUiEventIds.add(event.eventId);
      const target = event.ancestry[event.ancestry.length - 1] ?? 0;

      if (event.eventType === 'expand') {
        for (const noteId of event.ancestry) {
          if (!this.expanded.has(noteId)) {
            this.expanded.add(noteId);
            changed = true;
          }
        }
      } else if (event.eventType === 'collapse') {
        if (target !== 0 && this.expanded.has(target)) {
          this.expanded.delete(target);
          changed = true;
        }
      } else if (event.eventType === 'focus') {
        for (const noteId of event.ancestry) {
          if (!this.expanded.has(noteId)) {
            this.expanded.add(noteId);
            changed = true;
          }
        }
        if (this.focusedId !== target) {
          this.focusedId = target;
          changed = true;
        }
      } else if (event.eventType === 'select') {
        for (const noteId of event.ancestry) {
          if (!this.expanded.has(noteId)) {
            this.expanded.add(noteId);
            changed = true;
          }
        }
        if (this.focusedId !== target) {
          this.focusedId = target;
          changed = true;
        }
        if (this.selectedIds.size !== 1 || !this.selectedIds.has(target)) {
          this.selectedIds = new Set<number>([target]);
          this.selectedInstanceKeys = new Set<string>();
          changed = true;
        }
      }
    }
    if (changed) {
      this.renderTree();
    }
  }

  private attachGlobalEvents(): void {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keydown', () => this.scheduleAutoSave());
    document.addEventListener('mousedown', () => this.scheduleAutoSave());
    document.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      const insideDropdown = !!target.closest('.tnp-dropdown');
      if (!insideDropdown && (this.fileMenuOpen || this.settingsMenuOpen || this.databaseMenuOpen)) {
        this.fileMenuOpen = false;
        this.settingsMenuOpen = false;
        this.databaseMenuOpen = false;
        this.renderShell();
        this.renderTree();
      }
    });
  }

  private buildHelpRowsHtml(): string {
    const cmd = this.isMacPlatform() ? 'Cmd' : 'Ctrl';
    const rows: Array<[string, string]> = [
      ['Insert', 'Add a new note under the focused one'],
      ['Delete', 'Delete selected notes'],
      ['Up/Down Arrow', 'Move focus up/down'],
      ['Enter', 'Make a note editable'],
      ['Alt', 'Return an editable note to being uneditable'],
      ['Shift+Up/Down', 'Swap adjacent siblings'],
      ['Click on note', 'Focuses note'],
      [`${cmd}+Click`, 'Keep notes selected while focusing new one'],
      [`${cmd}+C/X/V`, 'Copy/Cut/Paste selected notes'],
      [`${cmd}+B`, 'Paste a reference of the copied note into the text box'],
      ['Tab', 'Toggle whether focused note is expanded'],
      ['Shift+Tab', 'Also expands children and grandchildren'],
    ];
    return rows
      .map(([command, description]) => `<tr><td>${command}</td><td>${description}</td></tr>`)
      .join('');
  }

  private isMacPlatform(): boolean {
    return /mac|iphone|ipad|ipod/i.test(window.navigator.platform);
  }

  private buildVisible(): VisibleItem[] {
    const out: VisibleItem[] = [];
    const walk = (
      noteId: number,
      depth: number,
      parentId: number | null,
      isReference: boolean,
      instanceKey: string,
    ): void => {
      if (noteId !== 0) {
        out.push({ noteId, depth, parentId, isReference, instanceKey });
        const isExpanded = isReference
          ? this.expandedReferenceInstances.has(instanceKey)
          : this.expanded.has(noteId);
        if (!isExpanded) {
          return;
        }
      }
      const note = this.store.getNote(noteId);
      if (!note) {
        return;
      }

      const refs = Array.from(this.referencesByNote.get(noteId) ?? []);
      const childIds = [...note.children, ...refs.filter((x) => !note.children.includes(x))];
      for (const childId of childIds) {
        const childDepth = noteId === 0 ? depth : depth + 1;
        const childIsReference = !note.children.includes(childId);
        const childKey = `${instanceKey}:${childIsReference ? 'ref' : 'child'}:${childId}`;
        walk(childId, childDepth, noteId, childIsReference, childKey);
      }
    };

    walk(0, 0, null, false, 'root');
    return out;
  }

  private renderTree(): void {
    const visible = this.buildVisible();
    this.ensureFocusedInstanceKey(visible);
    this.ensureSelectedInstanceKeys(visible);
    this.listEl.classList.toggle('isFocused', this.focusedId === 0 && this.focusedInstanceKey === 'root');

    this.listEl.innerHTML = '';
    for (const item of visible) {
      const note = this.store.getNote(item.noteId);
      if (!note) {
        continue;
      }

      const row = document.createElement('div');
      row.className = 'tnp-row';
      row.dataset.noteId = String(note.id);
      const indentPx = item.depth * 40;
      row.style.marginLeft = `${indentPx}px`;
      row.style.width = `calc(100% - ${indentPx}px)`;
      if (this.focusedId === note.id && this.focusedInstanceKey === item.instanceKey) {
        row.classList.add('focused');
      }
      if (this.selectedIds.has(note.id)) {
        if (this.selectedInstanceKeys.has(item.instanceKey)) {
          row.classList.add('selected');
        }
      }
      row.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.tnp-toggle') || target.closest('.tnp-editor')) {
          return;
        }
        if (target.tagName === 'A') {
          return;
        }
        this.focusRow(note.id, event.ctrlKey || event.metaKey, item.instanceKey);
      });

      const hasChildren = note.children.length > 0 || (this.referencesByNote.get(note.id)?.size ?? 0) > 0;
      const isExpanded = item.isReference
        ? this.expandedReferenceInstances.has(item.instanceKey)
        : this.expanded.has(note.id);
      const toggle = document.createElement('button');
      toggle.className = 'tnp-toggle';
      toggle.textContent = hasChildren ? (isExpanded ? 'v' : '>') : '>';
      if (hasChildren) {
        toggle.classList.add('boldText');
      }
      toggle.addEventListener('click', () => {
        if (!hasChildren) {
          return;
        }
        if (item.isReference) {
          if (this.expandedReferenceInstances.has(item.instanceKey)) {
            this.expandedReferenceInstances.delete(item.instanceKey);
          } else {
            this.expandedReferenceInstances.add(item.instanceKey);
          }
        } else {
          const nextExpanded = new Set(this.expanded);
          if (nextExpanded.has(note.id)) {
            nextExpanded.delete(note.id);
          } else {
            nextExpanded.add(note.id);
          }
          this.expanded.clear();
          for (const id of nextExpanded) {
            this.expanded.add(id);
          }
          if (this.storageMode === 'spacetime' && this.spacetimeRepo instanceof SpacetimeNotepadRepo) {
            void this.spacetimeRepo.saveUiState(this.currentName, {
              expanded: Array.from(nextExpanded),
              focusedNoteId: this.focusedId,
              selected: Array.from(this.selectedIds),
            });
          }
        }
        this.renderTree();
      });

      const content = document.createElement('div');
      content.className = 'tnp-content';
      if (this.editingId === note.id && note.id !== 0) {
        const textarea = document.createElement('textarea');
        textarea.value = note.markup;
        textarea.className = 'tnp-editor';
        textarea.addEventListener('input', () => {
          note.markup = textarea.value;
          this.markDirty();
          this.resizeEditor(textarea);
        });
        textarea.addEventListener('click', () => this.registerAnchors(textarea.value, note.id));
        content.appendChild(textarea);
        window.setTimeout(() => {
          textarea.focus();
          this.resizeEditor(textarea);
        }, 0);
      } else {
        const display = document.createElement('div');
        display.className = 'tnp-text';
        display.innerHTML = note.markup;
        this.decorateReferenceLinks(display);
        if (this.truncateNotes && !isExpanded && this.focusedId !== note.id && !this.selectedIds.has(note.id)) {
          display.classList.add('truncated');
        }
        display.addEventListener('click', (event) => {
          const target = event.target as HTMLElement;
          if (target.tagName === 'A' && target.id) {
            this.tryAddReference(note.id, Number(target.id));
            this.expanded.add(note.id);
            this.renderTree();
            event.stopPropagation();
            return;
          }
        });
        content.appendChild(display);
      }

      row.appendChild(toggle);
      row.appendChild(content);
      this.listEl.appendChild(row);
    }
    document.title = this.dirty ? `${this.currentName}*` : this.currentName;
  }

  private ensureFocusedInstanceKey(visible: VisibleItem[]): void {
    if (this.focusedId === 0) {
      this.focusedInstanceKey = 'root';
      return;
    }
    const exact = visible.some((entry) => entry.instanceKey === this.focusedInstanceKey);
    if (exact) {
      return;
    }
    const canonical = visible.find((entry) => entry.noteId === this.focusedId && !entry.isReference);
    if (canonical) {
      this.focusedInstanceKey = canonical.instanceKey;
      return;
    }
    const fallback = visible.find((entry) => entry.noteId === this.focusedId);
    this.focusedInstanceKey = fallback ? fallback.instanceKey : 'root';
  }

  private ensureSelectedInstanceKeys(visible: VisibleItem[]): void {
    if (this.selectedIds.size === 0) {
      this.selectedInstanceKeys.clear();
      return;
    }
    if (this.selectedInstanceKeys.size > 0) {
      return;
    }
    const mapped = new Set<string>();
    for (const id of this.selectedIds) {
      if (id === this.focusedId && this.focusedInstanceKey !== 'root') {
        mapped.add(this.focusedInstanceKey);
        continue;
      }
      const canonical = visible.find((entry) => entry.noteId === id && !entry.isReference);
      if (canonical) {
        mapped.add(canonical.instanceKey);
        continue;
      }
      const any = visible.find((entry) => entry.noteId === id);
      if (any) {
        mapped.add(any.instanceKey);
      }
    }
    this.selectedInstanceKeys = mapped;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.persistCurrentDocument(this.currentName);
      return;
    }

    const visible = this.buildVisible();
    const idx = visible.findIndex((x) => x.instanceKey === this.focusedInstanceKey);
    const focused = this.store.getNote(this.focusedId);
    if (!focused) {
      return;
    }

    if (this.editingId !== null) {
      if (e.key.toLowerCase() === 'alt') {
        e.preventDefault();
        this.editingId = null;
        this.renderTree();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.insertAtCursor('\t');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && this.copiedIds.length > 0) {
        e.preventDefault();
        this.insertReferenceLink();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedId === 0) {
          return;
        }
        if (e.shiftKey) {
          const parent = visible[idx]?.parentId;
          if (parent !== null && parent !== undefined) {
            this.store.swapChildren(parent, this.focusedId, true);
            this.markDirty();
            this.renderTree();
          }
          return;
        }
        if (idx > 0) {
          this.focusRow(visible[idx - 1].noteId, e.ctrlKey || e.metaKey, visible[idx - 1].instanceKey);
        }
        return;
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedId === 0) {
          if (visible.length > 0) {
            this.focusRow(visible[0].noteId, e.ctrlKey || e.metaKey, visible[0].instanceKey);
          }
          return;
        }
        if (e.shiftKey) {
          const parent = visible[idx]?.parentId;
          if (parent !== null && parent !== undefined) {
            this.store.swapChildren(parent, this.focusedId, false);
            this.markDirty();
            this.renderTree();
          }
          return;
        }
        if (idx >= 0 && idx < visible.length - 1) {
          this.focusRow(visible[idx + 1].noteId, e.ctrlKey || e.metaKey, visible[idx + 1].instanceKey);
        }
        return;
      case 'ArrowLeft': {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedId === 0) {
          return;
        }
        const parent = visible[idx]?.parentId;
        if (parent !== null && parent !== undefined) {
          if (parent === 0) {
            this.focusRoot(e.ctrlKey || e.metaKey);
          } else {
            const parentItem = visible.find((entry) => entry.noteId === parent && !entry.isReference)
              ?? visible.find((entry) => entry.noteId === parent);
            if (parentItem) {
              this.focusRow(parent, e.ctrlKey || e.metaKey, parentItem.instanceKey);
            }
          }
        }
        return;
      }
      case 'Insert': {
        e.preventDefault();
        e.stopPropagation();
        const child = this.store.addChild(this.focusedId);
        this.expanded.add(this.focusedId);
        if (!(e.ctrlKey || e.metaKey)) {
          this.focusedId = child.id;
          this.focusedInstanceKey = `root:child:${child.id}`;
          this.selectedIds = new Set([child.id]);
          this.selectedInstanceKeys = new Set([this.focusedInstanceKey]);
        }
        this.markDirty();
        this.renderTree();
        return;
      }
      case 'Delete': {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedId === 0) {
          return;
        }
        const focusedItem = visible[idx];
        const parent = focusedItem?.parentId;
        if (parent === null || parent === undefined) {
          return;
        }
        if (focusedItem?.isReference) {
          this.removeReference(parent, this.focusedId);
        } else {
          this.store.removeChild(parent, this.focusedId);
        }
        const nextFocus = idx > 0 ? visible[idx - 1].noteId : parent;
        this.focusedId = nextFocus;
        this.focusedInstanceKey = nextFocus === 0
          ? 'root'
          : (visible.find((entry) => entry.noteId === nextFocus && !entry.isReference)?.instanceKey
            ?? visible.find((entry) => entry.noteId === nextFocus)?.instanceKey
            ?? 'root');
        this.selectedIds = new Set([nextFocus]);
        this.selectedInstanceKeys = new Set([this.focusedInstanceKey]);
        this.markDirty();
        this.renderTree();
        return;
      }
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        const focusedItem = visible.find((entry) => entry.instanceKey === this.focusedInstanceKey);
        if (focusedItem?.isReference) {
          if (this.expandedReferenceInstances.has(this.focusedInstanceKey)) {
            this.expandedReferenceInstances.delete(this.focusedInstanceKey);
          } else {
            this.expandedReferenceInstances.add(this.focusedInstanceKey);
          }
        } else {
          if (this.expanded.has(this.focusedId)) {
            this.expanded.delete(this.focusedId);
          } else {
            this.expanded.add(this.focusedId);
          }
        }
        this.renderTree();
        return;
      case 'Enter':
        if (this.focusedId !== 0) {
          e.preventDefault();
          e.stopPropagation();
          this.editingId = this.focusedId;
          this.selectedIds = new Set([this.focusedId]);
          this.selectedInstanceKeys = new Set([this.focusedInstanceKey]);
          this.renderTree();
        }
        return;
      default:
        break;
    }

    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'c') {
      this.copiedIds = Array.from(this.selectedIds);
      this.copyMode = 'copy';
    } else if ((e.ctrlKey || e.metaKey) && key === 'x') {
      this.copiedIds = Array.from(this.selectedIds);
      this.copyMode = 'cut';
    } else if ((e.ctrlKey || e.metaKey) && key === 'v') {
      for (const copiedId of this.copiedIds) {
        const copied = this.store.getNote(copiedId);
        if (!copied) {
          continue;
        }
        if (!focused.children.includes(copied.id)) {
          focused.children.push(copied.id);
          if (this.copyMode === 'cut') {
            this.removeFromCurrentParent(copied.id, this.focusedId);
          }
        }
      }
      this.expanded.add(this.focusedId);
      this.markDirty();
      this.renderTree();
    }
  }

  private removeFromCurrentParent(noteId: number, exceptParentId: number): void {
    for (const note of Object.values(this.store.notes)) {
      if (note.id === exceptParentId) {
        continue;
      }
      if (note.children.includes(noteId)) {
        note.children = note.children.filter((id) => id !== noteId);
      }
    }
  }

  private removeReference(parentId: number, refId: number): void {
    const refs = this.referencesByNote.get(parentId);
    if (!refs) {
      return;
    }
    refs.delete(refId);
    if (refs.size === 0) {
      this.referencesByNote.delete(parentId);
      return;
    }
    this.referencesByNote.set(parentId, refs);
  }

  private focusRow(noteId: number, keepSelection: boolean, instanceKey: string): void {
    const nextSelected = keepSelection ? new Set([...this.selectedIds, noteId]) : new Set([noteId]);
    const nextSelectedInstances = keepSelection
      ? new Set([...this.selectedInstanceKeys, instanceKey])
      : new Set([instanceKey]);
    this.focusedId = noteId;
    this.focusedInstanceKey = instanceKey;
    this.selectedIds = nextSelected;
    this.selectedInstanceKeys = nextSelectedInstances;
    if (this.storageMode === 'spacetime' && this.spacetimeRepo instanceof SpacetimeNotepadRepo) {
      void this.spacetimeRepo.saveUiState(this.currentName, {
        expanded: Array.from(this.expanded),
        focusedNoteId: noteId,
        selected: Array.from(nextSelected),
      });
    }
    this.renderTree();
  }

  private focusRoot(keepSelection: boolean): void {
    const nextSelected = keepSelection ? new Set([...this.selectedIds]) : new Set<number>();
    const nextSelectedInstances = keepSelection ? new Set([...this.selectedInstanceKeys]) : new Set<string>();
    this.focusedId = 0;
    this.focusedInstanceKey = 'root';
    this.selectedIds = nextSelected;
    this.selectedInstanceKeys = nextSelectedInstances;
    if (this.storageMode === 'spacetime' && this.spacetimeRepo instanceof SpacetimeNotepadRepo) {
      void this.spacetimeRepo.saveUiState(this.currentName, {
        expanded: Array.from(this.expanded),
        focusedNoteId: 0,
        selected: Array.from(nextSelected),
      });
    }
    this.renderTree();
  }

  private promptAndRename(): void {
    const value = window.prompt('Rename document to:', this.currentName);
    if (!value) {
      return;
    }
    const nextName = value.trim();
    if (!nextName || nextName === this.currentName) {
      return;
    }
    void this.renameCurrentDocument(nextName);
  }

  private async renameCurrentDocument(nextName: string): Promise<void> {
    try {
      await this.repo.rename(this.currentName, nextName);
      if (this.storageMode !== 'spacetime') {
        this.currentName = nextName;
      }
      this.renderTree();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename document';
      window.alert(message);
    }
  }

  private loadPrompt(): void {
    const keys = this.repo.listKeys();
    if (keys.length === 0) {
      window.alert('No saved files in browser storage.');
      return;
    }
    this.openLoadDialog(keys);
  }

  private openLoadDialog(keys: string[]): void {
    const overlay = document.createElement('div');
    overlay.className = 'tnp-modal-overlay';
    const panel = document.createElement('div');
    panel.className = 'tnp-modal-panel';
    panel.innerHTML = `
      <div class="tnp-modal-title">Load Document</div>
      <div class="tnp-modal-subtitle">Single-click to select, double-click to load.</div>
      <div class="tnp-modal-list" data-role="modal-list"></div>
      <div class="tnp-modal-actions">
        <button data-action="modal-cancel">Cancel</button>
        <button data-action="modal-load">Load</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const list = panel.querySelector<HTMLElement>('[data-role="modal-list"]') as HTMLElement;
    let selected = keys[0];
    const makeRow = (key: string) => {
      const row = document.createElement('div');
      row.className = 'tnp-modal-row';
      if (key === selected) {
        row.classList.add('selected');
      }

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'tnp-modal-row-label';
      label.textContent = key;
      label.addEventListener('click', () => {
        selected = key;
        for (const element of list.querySelectorAll('.tnp-modal-row')) {
          element.classList.remove('selected');
        }
        row.classList.add('selected');
      });
      label.addEventListener('dblclick', () => {
        this.loadDocumentByKey(key);
        close();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'tnp-modal-row-delete';
      deleteBtn.textContent = 'X';
      deleteBtn.title = `Delete ${key}`;
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.repo.delete(key);
        row.remove();
        const remaining = Array.from(list.querySelectorAll('.tnp-modal-row-label')).map((el) => (el as HTMLButtonElement).textContent ?? '');
        if (remaining.length === 0) {
          close();
          return;
        }
        if (selected === key) {
          selected = remaining[0];
          const firstRow = list.querySelector('.tnp-modal-row');
          firstRow?.classList.add('selected');
        }
      });

      row.appendChild(label);
      row.appendChild(deleteBtn);
      return row;
    };

    for (const key of keys) {
      list.appendChild(makeRow(key));
    }

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      } else if (event.key === 'Enter') {
        this.loadDocumentByKey(selected);
        close();
      }
    };

    panel.querySelector<HTMLButtonElement>('[data-action="modal-cancel"]')?.addEventListener('click', close);
    panel.querySelector<HTMLButtonElement>('[data-action="modal-load"]')?.addEventListener('click', () => {
      this.loadDocumentByKey(selected);
      close();
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });
    document.addEventListener('keydown', onKey);
  }

  private loadDocumentByKey(picked: string): void {
    const data = this.repo.load(picked);
    if (!data) {
      window.alert('File not found.');
      return;
    }
    this.store.reset();
    this.store.loadFromJSON(data);
    if (this.storageMode !== 'spacetime') {
      this.currentName = picked;
    }
    this.focusedId = 0;
    this.selectedIds = new Set<number>();
    this.selectedInstanceKeys = new Set<string>();
    this.editingId = null;
    this.expanded.clear();
    this.expanded.add(0);
    this.markClean();
    this.currentDocFingerprint = JSON.stringify(data.notes);
    this.uiStateFingerprint = this.buildUiStateFingerprint();
    this.renderTree();

    if (this.storageMode === 'spacetime' && this.spacetimeRepo instanceof SpacetimeNotepadRepo) {
      void this.spacetimeRepo.setSessionDocument(picked).catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to update active session document';
        window.alert(message);
      });
    }
  }

  private deletePrompt(): void {
    const keys = this.repo.listKeys();
    if (keys.length === 0) {
      window.alert('No saved files in browser storage.');
      return;
    }
    this.openDeleteDialog(keys);
  }

  private openDeleteDialog(keys: string[]): void {
    const overlay = document.createElement('div');
    overlay.className = 'tnp-modal-overlay';
    const panel = document.createElement('div');
    panel.className = 'tnp-modal-panel';
    panel.innerHTML = `
      <div class="tnp-modal-title">Delete Document</div>
      <div class="tnp-modal-subtitle">Single-click to select, double-click to delete.</div>
      <div class="tnp-modal-list" data-role="modal-list"></div>
      <div class="tnp-modal-actions">
        <button data-action="modal-cancel">Cancel</button>
        <button data-action="modal-delete">Delete</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const list = panel.querySelector<HTMLElement>('[data-role="modal-list"]') as HTMLElement;
    let selected = keys[0];
    const makeRow = (key: string) => {
      const row = document.createElement('div');
      row.className = 'tnp-modal-row';
      if (key === selected) {
        row.classList.add('selected');
      }

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'tnp-modal-row-label';
      label.textContent = key;
      label.addEventListener('click', () => {
        selected = key;
        for (const element of list.querySelectorAll('.tnp-modal-row')) {
          element.classList.remove('selected');
        }
        row.classList.add('selected');
      });
      label.addEventListener('dblclick', async () => {
        await this.repo.delete(key);
        close();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'tnp-modal-row-delete';
      deleteBtn.textContent = 'X';
      deleteBtn.title = `Delete ${key}`;
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.repo.delete(key);
        row.remove();
        const remaining = Array.from(list.querySelectorAll('.tnp-modal-row-label')).map((el) => (el as HTMLButtonElement).textContent ?? '');
        if (remaining.length === 0) {
          close();
          return;
        }
        if (selected === key) {
          selected = remaining[0];
          const firstRow = list.querySelector('.tnp-modal-row');
          firstRow?.classList.add('selected');
        }
      });

      row.appendChild(label);
      row.appendChild(deleteBtn);
      return row;
    };

    for (const key of keys) {
      list.appendChild(makeRow(key));
    }

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      } else if (event.key === 'Enter') {
        void this.repo.delete(selected);
        close();
      }
    };

    panel.querySelector<HTMLButtonElement>('[data-action="modal-cancel"]')?.addEventListener('click', close);
    panel.querySelector<HTMLButtonElement>('[data-action="modal-delete"]')?.addEventListener('click', () => {
      void this.repo.delete(selected);
      close();
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });
    document.addEventListener('keydown', onKey);
  }

  private download(): void {
    const blob = new Blob([JSON.stringify(this.store.toSerializable())], { type: 'application/octet-stream' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${this.currentName}.tnp`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    this.markClean();
    this.renderTree();
  }

  private async uploadFile(file: File): Promise<void> {
    if (!file.name.endsWith('.tnp')) {
      return;
    }
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    const fileName = file.name.replace(/\.tnp$/i, '');
    this.store.merge(parsed, fileName);
    this.markDirty();
    this.renderTree();
  }

  private scheduleAutoSave(): void {
    if (this.disableAutoSave || !this.dirty) {
      return;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      void this.persistCurrentDocument(this.currentName);
    }, AUTO_SAVE_DELAY_MS);
  }

  private async persistCurrentDocument(docName: string): Promise<void> {
    try {
      await this.repo.save(docName, this.store.toSerializable());
      this.markClean();
      this.currentDocFingerprint = JSON.stringify(this.store.toSerializable().notes);
      this.renderTree();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save document';
      window.alert(message);
    }
  }

  private registerAnchors(markup: string, ownerId: number): void {
    const refs = new Set<number>();
    const linkPattern = /<a id="(\d+)">/g;
    let m: RegExpExecArray | null;
    while ((m = linkPattern.exec(markup)) !== null) {
      refs.add(Number(m[1]));
    }
    this.referencesByNote.set(ownerId, refs);
  }

  private tryAddReference(ownerId: number, refId: number): void {
    const refs = this.referencesByNote.get(ownerId) ?? new Set<number>();
    refs.add(refId);
    this.referencesByNote.set(ownerId, refs);
  }

  private insertAtCursor(text: string): void {
    if (this.editingId === null) {
      return;
    }
    const editor = this.root.querySelector<HTMLTextAreaElement>('.tnp-editor');
    if (!editor) {
      return;
    }
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText(text, start, end, 'end');
    const n = this.store.getNote(this.editingId);
    if (n) {
      n.markup = editor.value;
      this.markDirty();
    }
    this.resizeEditor(editor);
  }

  private insertReferenceLink(): void {
    if (this.editingId === null || this.copiedIds.length === 0) {
      return;
    }
    const editor = this.root.querySelector<HTMLTextAreaElement>('.tnp-editor');
    if (!editor) {
      return;
    }
    const selected = editor.value.substring(editor.selectionStart, editor.selectionEnd);
    const link = `<a id="${this.copiedIds[0]}">${selected}</a>`;
    this.insertAtCursor(link);
  }

  private resizeEditor(textarea: HTMLTextAreaElement): void {
    textarea.style.height = '1px';
    textarea.style.height = `${Math.max(24, textarea.scrollHeight)}px`;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private markClean(): void {
    this.dirty = false;
  }

  private decorateReferenceLinks(container: HTMLElement): void {
    const anchors = container.querySelectorAll('a[id]');
    for (const anchor of anchors) {
      const rawId = anchor.getAttribute('id');
      if (!rawId) {
        continue;
      }
      if (!anchor.getAttribute('href')) {
        anchor.setAttribute('href', `#note-${rawId}`);
      }
      anchor.classList.add('tnp-note-ref-link');
    }
  }
}
