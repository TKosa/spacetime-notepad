import type { SerializedStore } from './types';
import type { NotepadRepository } from './spacetimeRepo';

const RECORD_KEYS = 'tnpKeys';

export class LocalStorageRepo implements NotepadRepository {
  listKeys(): string[] {
    return JSON.parse(localStorage.getItem(RECORD_KEYS) ?? '[]') as string[];
  }

  async save(key: string, data: SerializedStore): Promise<void> {
    const old = this.listKeys();
    if (!old.includes(key)) {
      localStorage.setItem(RECORD_KEYS, JSON.stringify([key, ...old]));
    }
    localStorage.setItem(key, JSON.stringify(data));
  }

  load(key: string): SerializedStore | null {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as SerializedStore;
  }

  async delete(key: string): Promise<void> {
    const keys = this.listKeys().filter((x) => x !== key);
    localStorage.removeItem(key);
    localStorage.setItem(RECORD_KEYS, JSON.stringify(keys));
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    const normalizedOld = oldKey.trim();
    const normalizedNew = newKey.trim();
    if (!normalizedOld || !normalizedNew) {
      throw new Error('Document key cannot be empty');
    }
    if (normalizedOld === normalizedNew) {
      return;
    }
    const raw = localStorage.getItem(normalizedOld);
    if (!raw) {
      throw new Error('Source document not found');
    }
    if (localStorage.getItem(normalizedNew) !== null) {
      throw new Error('Destination document already exists');
    }
    localStorage.setItem(normalizedNew, raw);
    localStorage.removeItem(normalizedOld);
    const keys = this.listKeys().map((key) => (key === normalizedOld ? normalizedNew : key));
    localStorage.setItem(RECORD_KEYS, JSON.stringify(keys));
  }
}
