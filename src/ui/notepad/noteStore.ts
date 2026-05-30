import type { NoteId, SerializedNote, SerializedStore } from './types';

const CURRENT_VERSION = 2;

export class Note {
  id: NoteId;
  markup: string;
  children: NoteId[];

  constructor(id: NoteId, markup = '', children: NoteId[] = []) {
    this.id = id;
    this.markup = markup;
    this.children = [...children];
  }

  add(child: Note): void {
    if (!this.children.includes(child.id)) {
      this.children.push(child.id);
    }
  }
}

export class NoteStore {
  version: number;
  notes: Record<number, Note>;
  private uID: number;

  constructor() {
    this.version = CURRENT_VERSION;
    this.notes = { 0: new Note(0, '0', []) };
    this.uID = 1;
  }

  reset(): void {
    this.notes = { 0: new Note(0, '0', []) };
    this.uID = 1;
  }

  getRoot(): Note {
    const root = this.notes[0];
    if (!root) {
      throw new Error('Root note missing');
    }
    return root;
  }

  getNote(id: NoteId): Note | undefined {
    return this.notes[id];
  }

  getNewNote(): Note {
    while (this.notes[this.uID]) {
      this.uID += 1;
    }
    const n = new Note(this.uID);
    this.notes[n.id] = n;
    this.uID += 1;
    return n;
  }

  addChild(parentId: NoteId): Note {
    const parent = this.getNote(parentId);
    if (!parent) {
      throw new Error(`Parent note ${parentId} does not exist`);
    }
    const child = this.getNewNote();
    parent.add(child);
    return child;
  }

  removeChild(parentId: NoteId, childId: NoteId): void {
    const parent = this.getNote(parentId);
    if (!parent) {
      return;
    }
    parent.children = parent.children.filter((id) => id !== childId);
  }

  swapChildren(parentId: NoteId, childId: NoteId, moveUp: boolean): void {
    const parent = this.getNote(parentId);
    if (!parent) {
      return;
    }
    const idx = parent.children.indexOf(childId);
    if (idx < 0) {
      return;
    }
    const next = moveUp ? idx - 1 : idx + 1;
    if (next < 0 || next >= parent.children.length) {
      return;
    }
    [parent.children[idx], parent.children[next]] = [parent.children[next], parent.children[idx]];
  }

  toSerializable(): SerializedStore {
    const out: SerializedStore = {
      version: this.version,
      notes: {},
    };
    this.addNoteAndDescendants(this.getRoot(), out.notes);
    return out;
  }

  private addNoteAndDescendants(note: Note, out: Record<number, SerializedNote>): void {
    if (out[note.id]) {
      return;
    }

    out[note.id] = {
      id: note.id,
      markup: note.markup,
      children: [...note.children],
    };

    const linkPattern = /<a id="(\d+)">/g;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(note.markup)) !== null) {
      const refId = Number(match[1]);
      const refNote = this.notes[refId];
      if (refNote) {
        this.addNoteAndDescendants(refNote, out);
      }
    }

    for (const childId of note.children) {
      const child = this.notes[childId];
      if (child) {
        this.addNoteAndDescendants(child, out);
      }
    }
  }

  loadFromJSON(incoming: SerializedStore): void {
    this.reset();
    this.notes = {};
    const ids = Object.keys(incoming.notes).map(Number);
    for (const id of ids) {
      const n = incoming.notes[id];
      this.notes[id] = new Note(id, String(n.markup ?? ''), [...(n.children ?? [])]);
    }
    if (!this.notes[0]) {
      this.notes[0] = new Note(0, '0', []);
    }
    this.version = incoming.version || CURRENT_VERSION;
    this.uID = Math.max(...Object.keys(this.notes).map(Number), 0) + 1;
  }

  merge(incoming: SerializedStore, fileName: string): void {
    const temp = new NoteStore();
    temp.loadFromJSON(incoming);

    const taken = new Set<number>(Object.keys(this.notes).map(Number));
    const remap = new Map<number, number>();

    for (const oldId of Object.keys(temp.notes).map(Number)) {
      let newId = oldId;
      while (taken.has(newId) || remapHasValue(remap, newId)) {
        newId += 1;
      }
      remap.set(oldId, newId);
    }

    const remapped: Record<number, Note> = {};
    for (const [oldId, newId] of remap.entries()) {
      const old = temp.notes[oldId];
      const markup = old.markup.replace(/<a id="(\d+)">/g, (_all, idText: string) => {
        const mapped = remap.get(Number(idText));
        return mapped !== undefined ? `<a id="${mapped}">` : `<a id="${idText}">`;
      });
      const children = old.children.map((id) => remap.get(id) ?? id);
      remapped[newId] = new Note(newId, markup, children);
    }

    for (const [idText, note] of Object.entries(remapped)) {
      this.notes[Number(idText)] = note;
    }

    const mergedRoot = remapped[remap.get(0) ?? 0];
    if (mergedRoot) {
      const root = this.getRoot();
      if (root.children.length === 0) {
        root.children = [...mergedRoot.children];
      } else {
        mergedRoot.markup = fileName;
        root.add(mergedRoot);
      }
    }
  }
}

function remapHasValue(map: Map<number, number>, value: number): boolean {
  for (const v of map.values()) {
    if (v === value) {
      return true;
    }
  }
  return false;
}
