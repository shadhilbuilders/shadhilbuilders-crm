// T-LEAD-STATE-CHIP-TONE (2026-09-30) - the visit dialog's status chip.
//
// THE BUG. The chip printed the LEAD's pipeline state ("Won 🎉", "Didn't show
// up") but took its colour from the VISIT's status. So a chip could read
// "Won 🎉" and be green because the VISIT was COMPLETED - or read "Didn't show
// up" over a green chip because the visit completed and the lead was marked a
// no-show afterwards. Two records, one colour, in one line.
//
// `lead-state-tone.test.ts` pins the map. THIS file pins the WIRING: that the
// dialog actually consults the map, and that the two axes render distinctly. A
// map alone proves nothing about which one the chip reads.
//
// `renderToStaticMarkup` cannot be used here: the Dialog primitive mounts its
// content only once OPEN, so static markup returns just the trigger (verified -
// 191 chars, trigger only). This mounts into jsdom and clicks the trigger, the
// same approach LeadVisitPanel.test.tsx uses for a click-driven assertion.
//
// Asserted on `data-tone`, which the chip publishes for exactly this purpose:
// grepping Tailwind class names would break on any restyle, while the tone is
// the semantic value under test.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useUpdateVisitOutcome: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  // T-LEAD-SYNC-COVERAGE (2026-09-30): imported by the dialog now - a partial
  // mock must expose every export the component reads.
  leadSyncNoteOf: () => null,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({ user: { id: 'u-1', role: 'ADMIN' }, isPending: false })),
  canLogVisitOutcome: vi.fn(() => true),
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: vi.fn(() => 'shadhil'),
  useProjectSlug: vi.fn(() => 'mudichur'),
}));

vi.mock('@/components/shared/RescheduleVisitDialog', () => ({
  RescheduleVisitDialog: () => null,
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return { ...actual, toast: { error: vi.fn(), success: vi.fn() } };
});

import { EventDetailsDialog } from './event-details-dialog';

import type { IEvent } from '../interfaces';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * A visit whose VISIT status and LEAD state deliberately DISAGREE - the exact
 * shape that produced the bad chip: the visit completed, the deal was marked a
 * no-show. Under the old code this rendered a GREEN chip reading "Didn't show
 * up".
 */
function eventWith(visit: IEvent['visit']): IEvent {
  return {
    id: 'visit-1',
    startDate: '2026-09-30T10:00:00.000Z',
    endDate: '2026-09-30T11:00:00.000Z',
    title: 'Anjali P.',
    color: 'red',
    description: '',
    user: { id: 'u-2', name: 'Lakshmi N.', picturePath: null },
    visit,
  };
}

/** Mount the dialog and OPEN it, then read the document it rendered into. */
async function openDialog(visit: IEvent['visit']): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <EventDetailsDialog event={eventWith(visit)}>
        <button type="button">open</button>
      </EventDetailsDialog>,
    );
  });

  const trigger = container.querySelector('button');
  if (trigger === null) throw new Error('dialog trigger not found');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  // The dialog content is portalled, so read the DOCUMENT, not the container.
  return document.body.innerHTML;
}

/** The chip's published tone. */
function chipTone(html: string): string {
  return /data-tone="([a-z]+)"/.exec(html)?.[1] ?? '';
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('EventDetailsDialog status chip - coloured by the LEAD state it labels', () => {
  it('shows a NO_SHOW lead as RED even when the visit itself COMPLETED', async () => {
    // THE REPORTED DEFECT, exactly. The old code rendered green here because
    // `visitStatusColor('COMPLETED', 'COMPLETED')` is green - the colour of the
    // VISIT, on a chip whose word was the LEAD's.
    const html = await openDialog({
      status: 'COMPLETED',
      outcome: 'COMPLETED',
      leadId: 'lead-1',
      leadState: 'NO_SHOW',
    });
    expect(html).toContain("Didn't show up");
    expect(chipTone(html)).toBe('red');
  });

  it('shows a WON lead as GREEN, and the chip says which axis it is', async () => {
    const html = await openDialog({
      status: 'COMPLETED',
      outcome: 'COMPLETED',
      leadId: 'lead-1',
      leadState: 'WON',
    });
    expect(html).toContain('Won');
    expect(chipTone(html)).toBe('green');
    // The label that stops a green "Didn't show up" reading as a contradiction.
    expect(html).toContain('Deal status');
  });

  it('does NOT let the visit status drive the chip tone', async () => {
    // Two leads with the IDENTICAL visit record must not share a chip tone when
    // their lead states differ - the direct falsification of "the chip reads the
    // visit", which is what the old code did.
    const visit = { status: 'COMPLETED', outcome: 'COMPLETED' } as const;
    const noShow = chipTone(
      await openDialog({ ...visit, leadId: 'l', leadState: 'NO_SHOW' }),
    );
    await act(async () => {
      root?.unmount();
    });
    document.body.innerHTML = '';
    const won = chipTone(await openDialog({ ...visit, leadId: 'l', leadState: 'WON' }));

    expect(noShow).toBe('red');
    expect(won).toBe('green');
  });

  it('still shows the VISIT story in the outcome line', async () => {
    // The other axis must survive the fix: the "What happened on site" line is
    // the visit's record. Here the lead is waiting on a visit (yellow chip) and
    // the visit says no-show - two axes, two records, no conflation.
    const html = await openDialog({
      status: 'SCHEDULED',
      outcome: 'NO_SHOW',
      leadId: 'lead-1',
      leadState: 'VISIT_REQUESTED',
    });
    expect(html).toContain('What happened on site');
    expect(chipTone(html)).toBe('yellow');
    expect(html).toContain("Didn't show up");
  });

  it('degrades an unknown lead state to a neutral chip rather than guessing', async () => {
    const html = await openDialog({
      status: 'SCHEDULED',
      outcome: null,
      leadId: 'lead-1',
      leadState: 'SOMETHING_NEW',
    });
    expect(chipTone(html)).toBe('gray');
  });
});
