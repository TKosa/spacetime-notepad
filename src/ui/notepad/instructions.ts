import type { SerializedStore } from './types';

export const instructions: SerializedStore = {
  version: 2,
  notes: {
    0: { id: 0, markup: '0', children: [1] },
    1: { id: 1, markup: 'Instructions', children: [2, 3, 4, 5, 6] },
    2: { id: 2, markup: 'Use Arrow Up / Down to move focus.', children: [] },
    3: { id: 3, markup: 'Press Insert to add a child note.', children: [] },
    4: { id: 4, markup: 'Press Enter to edit focused note.', children: [] },
    5: { id: 5, markup: 'Press Alt to stop editing.', children: [] },
    6: { id: 6, markup: 'Use Tab to expand/collapse.', children: [] },
  },
};
