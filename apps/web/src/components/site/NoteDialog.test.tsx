// NoteDialog focus-on-open (2026-11-09).
//
// protects= opening the note dialog leaves NOTHING visibly focused: the focus
//           target is the dialog's own popup (the `outline-none` surface), so
//           the photo tile, the close button and the stage chips all arrive
//           unringed. A screen reader still gets its title + description.
// fails_when= the primitive's default returns - it focuses the first tabbable
//           control, a programmatically focused button matches `:focus-visible`,
//           and the dialog opens looking like the engineer already touched the
//           first photo;
// no_claim= it does not prove rendering (Tailwind is absent from jsdom, so a
//           ring could never be measured). It asserts the focus TARGET, which is
//           the thing that decides it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { NoteDialog, type NoteDialogProps } from './NoteDialog';
import { QUICK_NOTE_LABELS } from '@/lib/site-photos';

const baseProps: NoteDialogProps = {
  open: true,
  onOpenChange: () => undefined,
  onSave: () => undefined,
  attachments: [
    {
      id: 'a1',
      previewUrl: 'data:image/webp;base64,QQ==',
      filename: 'site-photo.webp',
      bytes: 240_000,
      status: 'ready',
    },
  ],
  isSaving: false,
  isOffline: false,
  isPreparing: false,
  unitNumber: 'B-101',
  phaseName: 'Phase B',
  onAddFiles: () => undefined,
  onRemoveAttachment: () => undefined,
  note: '',
  onNoteChange: () => undefined,
  selectedChips: [],
  onToggleChip: () => undefined,
  stage: null,
  onStageChange: () => undefined,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mount with effects, then give base-ui's queued focus a frame to land. */
async function mountDialog(props: NoteDialogProps): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<NoteDialog {...props} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('NoteDialog focus on open', () => {
  it('focuses the popup surface, not a control, so nothing is ringed', async () => {
    await mountDialog(baseProps);

    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBeNull();
    // The popup: the one element styled `outline-none`.
    expect(active?.getAttribute('data-slot')).toBe('dialog-content');
    expect(active?.getAttribute('role')).toBe('dialog');
    // Never a control: a button would match :focus-visible and draw a ring.
    expect(active?.tagName).not.toBe('BUTTON');
    expect(active?.tagName).not.toBe('INPUT');
  });

  it('still names the dialog for assistive tech while focus is on the surface', async () => {
    await mountDialog(baseProps);

    const active = document.activeElement as HTMLElement | null;
    const labelledBy = active?.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('What did you shoot?');
  });

  it('keeps the note field unfocused, so no keyboard covers the photo strip', async () => {
    await mountDialog(baseProps);

    const noteInput = document.querySelector('[data-qa="site-note-input"]');
    expect(noteInput).not.toBeNull();
    expect(document.activeElement).not.toBe(noteInput);
  });
});

describe('NoteDialog stage + quick notes', () => {
  /** Open a popup and return its options. Select opens on click; the chips
   *  input has no trigger button, so it is opened from the keyboard. */
  async function openAndCollect(trigger: Element | null, viaKeyboard = false): Promise<string[]> {
    const element = trigger as HTMLElement | null;
    await act(async () => {
      element?.focus();
      if (viaKeyboard) {
        element?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      } else {
        element?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        element?.click();
      }
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    return optionTexts();
  }

  function optionTexts(): string[] {
    return Array.from(document.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent ?? '',
    );
  }

  it('lists the nine stages plus an explicit "not set" in the Select', async () => {
    await mountDialog(baseProps);

    const options = await openAndCollect(document.querySelector('[data-qa="select-trigger"]'));
    expect(options).toEqual([
      'Stage not set',
      'Not started',
      'Foundation',
      'Structure',
      'Brickwork',
      'Plastering',
      'Waterproofing',
      'Flooring',
      'Finishing',
      'Ready',
    ]);
  });

  it('picks a stage and reports the enum value, not the label', async () => {
    const seen: Array<string | null> = [];
    await mountDialog({ ...baseProps, onStageChange: (next) => seen.push(next) });

    await openAndCollect(document.querySelector('[data-qa="select-trigger"]'));
    const structure = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent === 'Structure',
    );
    await act(async () => {
      (structure as HTMLElement | undefined)?.click();
    });

    expect(seen).toEqual(['STRUCTURE']);
  });

  it('maps "Stage not set" back to null, never to NOT_STARTED', async () => {
    const seen: Array<string | null> = [];
    await mountDialog({
      ...baseProps,
      stage: 'STRUCTURE',
      onStageChange: (next) => seen.push(next),
    });

    await openAndCollect(document.querySelector('[data-qa="select-trigger"]'));
    const unset = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent === 'Stage not set',
    );
    await act(async () => {
      (unset as HTMLElement | undefined)?.click();
    });

    expect(seen).toEqual([null]);
  });

  it('offers all six quick notes as suggestion chips', async () => {
    await mountDialog(baseProps);

    // A suggestion row of buttons, each one a tap away - not another input the
    // engineer has to open first.
    const chips = Array.from(
      document.querySelectorAll('[data-qa="site-note-quick-picker"] button'),
    ).map((chip) => chip.textContent ?? '');
    expect(chips).toEqual([...QUICK_NOTE_LABELS]);
  });

  it('adds ONE quick note per tap and never reports the whole list as an add', async () => {
    const toggles: Array<[string, boolean]> = [];
    await mountDialog({
      ...baseProps,
      selectedChips: ['Slab'],
      onToggleChip: (label, selected) => toggles.push([label, selected]),
    });

    const issue = document.querySelector('[data-qa="site-note-chip-issue"]');
    await act(async () => {
      (issue as HTMLElement | null)?.click();
    });

    // Exactly ONE toggle, and it is the line that changed.
    expect(toggles).toEqual([['Issue', true]]);
  });

  it('hands both actions to the library DialogFooter', async () => {
    await mountDialog(baseProps);

    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    // Cancel first in DOM, then Save: the library stacks them column-reverse on
    // a phone, so Cancel reads above Save where the thumb lands.
    expect(footer?.querySelector('[data-qa="site-note-cancel"]')?.textContent).toBe('Cancel');
    expect(footer?.querySelector('[data-qa="site-save-photo"]')).not.toBeNull();
  });

  it('asks before discarding unsent photos, and does not close until answered', async () => {
    const changes: boolean[] = [];
    await mountDialog({ ...baseProps, onOpenChange: (next) => changes.push(next) });

    const cancel = document.querySelector('[data-qa="site-note-cancel"]');
    await act(async () => {
      (cancel as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    // The note dialog is STILL open: one unsettled photo, so the question comes
    // first and nothing is discarded behind the engineer's back.
    expect(changes).toEqual([]);
    const confirmDialog = document.querySelector('[data-slot="alert-dialog-content"]');
    expect(confirmDialog).not.toBeNull();
    // Singular for one photo, plural for a batch: the copy matches what is lost.
    expect(confirmDialog?.textContent).toContain('Discard this photo?');
    expect(confirmDialog?.textContent).toContain('This photo has not been saved yet.');
  });

  it('closes without asking when nothing is unsent', async () => {
    const changes: boolean[] = [];
    await mountDialog({
      ...baseProps,
      attachments: [
        {
          id: 'a1',
          previewUrl: 'data:image/webp;base64,QQ==',
          filename: 'site-photo.webp',
          bytes: 240_000,
          status: 'saved',
        },
      ],
      onOpenChange: (next) => changes.push(next),
    });

    const cancel = document.querySelector('[data-qa="site-note-cancel"]');
    await act(async () => {
      (cancel as HTMLElement | null)?.click();
    });

    // Nothing to lose, so no question: a needless confirmation trains people to
    // dismiss confirmations unread.
    expect(changes).toEqual([false]);
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it('keeps editing on "Keep editing" and discards only on "Discard"', async () => {
    const changes: boolean[] = [];
    await mountDialog({ ...baseProps, onOpenChange: (next) => changes.push(next) });

    await act(async () => {
      (document.querySelector('[data-qa="site-note-cancel"]') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    const keep = document.querySelector('[data-qa="alert-dialog-cancel"]');
    await act(async () => {
      (keep as HTMLElement | null)?.click();
    });

    // Back to the note, nothing closed.
    expect(changes).toEqual([]);
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();

    // Now go through with it.
    await act(async () => {
      (document.querySelector('[data-qa="site-note-cancel"]') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    const discard = document.querySelector('[data-qa="alert-dialog-action"]');
    await act(async () => {
      (discard as HTMLElement | null)?.click();
    });

    expect(changes).toEqual([false]);
  });

  it('asks on the X too, so every exit agrees', async () => {
    const changes: boolean[] = [];
    await mountDialog({ ...baseProps, onOpenChange: (next) => changes.push(next) });

    // The library's close button and the Cancel button must not disagree about
    // whether unsent work is thrown away silently.
    const close = document.querySelector('[data-qa="dialog-close"]');
    await act(async () => {
      (close as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(changes).toEqual([]);
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).not.toBeNull();
  });

  it('keeps Cancel disabled while a save is in flight', async () => {
    await mountDialog({ ...baseProps, isSaving: true });

    const cancel = document.querySelector('[data-qa="site-note-cancel"]');
    expect(cancel).not.toBeNull();
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
  });
});
