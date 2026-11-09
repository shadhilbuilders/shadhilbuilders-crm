// editNoteSchema: the rule the Edit note dialog enforces before any write.
//
// protects= the note is trimmed and required, capped at NOTE_MAX_LENGTH, and the
//           stage is either a real construction stage or '' (none recorded);
// fails_when= a blank/over-long note validates, or an invented stage passes.
import { describe, expect, it } from 'vitest';

import { editNoteSchema, NOTE_MAX_LENGTH } from './EditNoteDialog';

describe('editNoteSchema', () => {
  it('trims the note', () => {
    const parsed = editNoteSchema.parse({ caption: '  Slab poured  ', stage: '' });
    expect(parsed.caption).toBe('Slab poured');
  });

  it('rejects a blank note', () => {
    expect(editNoteSchema.safeParse({ caption: '   ', stage: '' }).success).toBe(false);
  });

  it('rejects a note over the limit and accepts one at the limit', () => {
    const at = 'x'.repeat(NOTE_MAX_LENGTH);
    expect(editNoteSchema.safeParse({ caption: at, stage: '' }).success).toBe(true);
    expect(editNoteSchema.safeParse({ caption: `${at}x`, stage: '' }).success).toBe(false);
  });

  it('accepts a real stage and rejects an invented one', () => {
    expect(editNoteSchema.safeParse({ caption: 'a', stage: 'STRUCTURE' }).success).toBe(true);
    expect(editNoteSchema.safeParse({ caption: 'a', stage: 'PAINTING_PARTY' }).success).toBe(false);
  });
});
