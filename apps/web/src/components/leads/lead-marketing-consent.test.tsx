// Site-update consent panel on the lead detail page (2026-11-23, re-scoped
// 2026-11-27: only a denial stops a send).
//
// protects= the screen tells the three states apart - "not asked" is not shown
// as a refusal - and the dialog submits what the operator actually chose, with
// the source that makes the ledger row meaningful.
// fails_when= "never asked" renders as "opted out", or the form sends a default
// source the operator did not pick.
//
// No @testing-library/react in this repo: static markup for render assertions,
// createRoot + act for the submit (same split as lead-facts-panel.test.tsx).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LeadDetail } from '@shadhil/api-types';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock('@/hooks/queries/crm', () => ({
  useRecordLeadConsent: () => ({ mutate: state.mutate, isPending: state.isPending }),
}));

import { LeadConsentForm, LeadMarketingConsent } from './lead-marketing-consent';

function lead(overrides: Partial<LeadDetail> = {}): LeadDetail {
  return {
    id: 'lead-1',
    name: 'Ramesh Kumar',
    phone: '919876543210',
    email: 'ramesh@example.com',
    notes: null,
    budget: null,
    source: 'WEBSITE',
    status: 'NEW',
    ownerId: 'user-1',
    ownerName: 'Asha',
    ownerType: 'TELECALLER',
    coOwnerId: null,
    coOwnerName: null,
    teamId: 'team-1',
    projectId: 'project-1',
    createdAt: '2026-11-01T06:00:00.000Z',
    updatedAt: '2026-11-01T06:00:00.000Z',
    ...overrides,
  };
}

describe('LeadMarketingConsent', () => {
  afterEach(() => {
    state.mutate.mockReset();
    state.isPending = false;
  });

  it('says "Not asked yet" for a lead with no consent row', () => {
    // The state most existing leads are in. Showing it as "opted out" would
    // tell a rep the buyer refused when nobody ever asked them - and, since the
    // templates are UTILITY, it would also be wrong about the send: an unasked
    // buyer still receives updates.
    const html = renderToStaticMarkup(<LeadMarketingConsent lead={lead()} />);

    expect(html).toContain('Not asked yet');
    expect(html).toContain('a villa they have booked is a service message');
    expect(html).not.toContain('Asked us to stop');
    expect(html).toContain('data-qa="lead-consent-record-button"');
  });

  it('shows an opt-in with the moment it was given', () => {
    const html = renderToStaticMarkup(
      <LeadMarketingConsent
        lead={lead({
          marketingConsent: 'granted',
          marketingConsentAt: '2026-11-23T10:00:00.000Z',
        })}
      />,
    );

    expect(html).toContain('Agreed to updates on');
    expect(html).toContain('Site updates reach this buyer at any time');
  });

  it('shows a refusal and says the earlier answer is kept', () => {
    const html = renderToStaticMarkup(
      <LeadMarketingConsent
        lead={lead({
          marketingConsent: 'denied',
          marketingConsentAt: '2026-11-23T10:00:00.000Z',
        })}
      />,
    );

    expect(html).toContain('Asked us to stop on');
    expect(html).toContain('the newest answer is the one that counts');
  });

  it('names how the answer was given and quotes what the buyer said', () => {
    // The record is only useful if the rep can read it back: "denied on 27 Nov"
    // does not tell them the words, and the words are why they typed anything.
    const html = renderToStaticMarkup(
      <LeadMarketingConsent
        lead={lead({
          marketingConsent: 'denied',
          marketingConsentAt: '2026-11-27T12:09:40.000Z',
          marketingConsentSource: 'call_verbal',
          marketingConsentNote: 'Asked us to stop calling about offers',
        })}
      />,
    );

    expect(html).toContain('Asked us to stop on');
    expect(html).toContain('Recorded as During a call');
    expect(html).toContain('They said:');
    expect(html).toContain('Asked us to stop calling about offers');
  });

  it('does not invent a source or a quote when the record has neither', () => {
    const html = renderToStaticMarkup(
      <LeadMarketingConsent
        lead={lead({
          marketingConsent: 'granted',
          marketingConsentAt: '2026-11-27T12:09:40.000Z',
          marketingConsentSource: 'whatsapp_button',
          marketingConsentNote: null,
        })}
      />,
    );

    expect(html).toContain('Recorded as WhatsApp reply');
    expect(html).not.toContain('They said');
  });

  it('shows no record line at all for a lead nobody has asked', () => {
    const html = renderToStaticMarkup(<LeadMarketingConsent lead={lead()} />);

    expect(html).not.toContain('Recorded as');
    expect(html).not.toContain('They said');
  });
});

describe('LeadConsentForm', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    state.mutate.mockReset();
  });

  it('offers both answers and all four sources', () => {
    const html = renderToStaticMarkup(
      <LeadConsentForm
        answer="granted"
        note=""
        source="call_verbal"
        pending={false}
        onAnswerChange={vi.fn()}
        onNoteChange={vi.fn()}
        onSourceChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain('Yes, they agreed to site updates');
    expect(html).toContain('No, they asked us not to');
    expect(html).toContain('During a call');
    expect(html).toContain('In person');
    expect(html).toContain('WhatsApp reply');
    expect(html).toContain('Booking form');
    expect(html).toContain('data-qa="lead-consent-note"');
  });

  it('submits the default answer and source without inventing a note', () => {
    const onSubmit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <LeadConsentForm
          answer="granted"
          note=""
          source="call_verbal"
          pending={false}
          onAnswerChange={vi.fn()}
          onNoteChange={vi.fn()}
          onSourceChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });

    const form = container.querySelector('#lead-consent-form') as HTMLFormElement | null;
    expect(form).not.toBeNull();

    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ granted: true, source: 'call_verbal' });
  });

  it('opens with the recorded note already in the box', async () => {
    // The bug this protects: the textarea always started empty, so a rep who
    // saved a note reopened the dialog to a blank box and could not tell
    // whether their words had been stored. Rendered through the real dialog
    // (not the form alone) because the seeding happens in LeadMarketingConsent.
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <LeadMarketingConsent
          lead={lead({
            marketingConsent: 'denied',
            marketingConsentAt: '2026-11-27T12:09:40.000Z',
            marketingConsentSource: 'call_verbal',
            marketingConsentNote: 'Asked for no offers, updates are fine',
          })}
        />,
      );
    });

    const open = document.body.querySelector(
      '[data-qa="lead-consent-record-button"]',
    ) as HTMLElement | null;
    await act(async () => {
      open?.click();
    });

    const box = document.body.querySelector(
      'textarea[data-qa="lead-consent-note"], [data-qa="lead-consent-note"] textarea',
    ) as HTMLTextAreaElement | null;
    expect(box).not.toBeNull();
    expect(box?.value).toBe('Asked for no offers, updates are fine');

    // Same answer and same words is a submit that writes nothing, so Save must
    // not offer it. Typing one word makes it a new statement.
    const save = document.body.querySelector('[data-qa="lead-consent-save"]') as HTMLElement | null;
    expect(save).not.toBeNull();
    expect(save?.hasAttribute('disabled')).toBe(true);
  });

  it('submits "denied" when the operator picked the refusal', () => {
    const onSubmit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <LeadConsentForm
          answer="denied"
          note=""
          source="call_verbal"
          pending={false}
          onAnswerChange={vi.fn()}
          onNoteChange={vi.fn()}
          onSourceChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });

    const form = container.querySelector('#lead-consent-form') as HTMLFormElement | null;
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ granted: false, source: 'call_verbal' });
  });
});
