export type NoteId = number;

export type SerializedNote = {
  id: NoteId;
  markup: string;
  children: NoteId[];
};

export type SerializedStore = {
  version: number;
  notes: Record<number, SerializedNote>;
};
