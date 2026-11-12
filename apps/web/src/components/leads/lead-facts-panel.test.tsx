// T-LEAD-FACTS (2026-11-05): the suggestion sheet on the lead detail page.
//
// No @testing-library/react in this repo, so render assertions use
// renderToStaticMarkup and the click uses createRoot + act (the same split
// LeadVisitPanel.test.tsx uses - static markup never runs effects).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LeadFactRow } from '@shadhil/api-types';

const state = vi.hoisted(() => ({
  facts: [] as unknown[],
  mutate: vi.fn(),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useLeadFacts: () => ({
    data: { leadId: 'lead-1', values: {}, facts: state.facts },
    isPending: false,
  }),
  useDecideLeadFact: () => ({ mutate: state.mutate, isPending: false }),
}));

import { LeadFactsPanel } from './lead-facts-panel';

function fact(overrides: Partial<LeadFactRow>): LeadFactRow {
  return {
    id: 'fact-1',
    leadId: 'lead-1',
    field: 'email',
    value: 'ramesh.kumar@example.com',
    score: 0.67,
    band: 'PROBABLE',
    status: 'PROPOSED',
    rationale: 'Their own message says so, but nothing that identifies them directly.',
    evidence: [{ kind: 'whatsapp.message-mentions', detail: 'signed the message' }],
    method: 'whatsapp-thread',
    sourceUrl: null,
    observedAt: '2026-11-05T06:00:00.000Z',
    decidedById: null,
    decidedAt: null,
    ...overrides,
  };
}

describe('LeadFactsPanel', () => {
  it('renders nothing at all when the lead has no ledger activity', () => {
    state.facts = [];
    expect(renderToStaticMarkup(<LeadFactsPanel leadId="lead-1" />)).toBe('');
  });

  it('shows a suggestion with its band, its reason and the two decisions', () => {
    state.facts = [fact({})];
    const html = renderToStaticMarkup(<LeadFactsPanel leadId="lead-1" />);

    expect(html).toContain('One suggestion needs a decision');
    expect(html).toContain('ramesh.kumar@example.com');
    // The friendly band label, not the raw enum.
    expect(html).toContain('Probable');
    expect(html).not.toContain('PROBABLE');
    // The sentence a rep decides on, not a score.
    expect(html).toContain('nothing that identifies them directly');
    expect(html).toContain('data-qa="lead-fact-accept"');
    expect(html).toContain('data-qa="lead-fact-dismiss"');
  });

  it('shows an applied value as provenance, with no buttons', () => {
    state.facts = [
      fact({
        status: 'APPLIED',
        band: 'VERIFIED',
        value: 'ramesh@example.com',
        rationale: 'The landing enquiry form itself carried this address',
      }),
    ];
    const html = renderToStaticMarkup(<LeadFactsPanel leadId="lead-1" />);

    expect(html).toContain('Where these values came from');
    expect(html).toContain('ramesh@example.com');
    expect(html).toContain('Verified');
    expect(html).toContain('The landing enquiry form itself carried this address');
    expect(html).not.toContain('data-qa="lead-fact-accept"');
  });

  it('does not offer a suggestion when every fact is already applied', () => {
    state.facts = [fact({ status: 'APPLIED' })];
    const html = renderToStaticMarkup(<LeadFactsPanel leadId="lead-1" />);

    expect(html).not.toContain('data-qa="lead-fact-suggestions"');
  });

  describe('deciding', () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;

    afterEach(() => {
      act(() => root?.unmount());
      root = null;
      container?.remove();
      container = null;
      state.mutate.mockReset();
    });

    it('accepting sends ACCEPT for that fact and nothing else', () => {
      state.facts = [fact({ id: 'fact-42' })];
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      act(() => {
        root?.render(<LeadFactsPanel leadId="lead-1" />);
      });

      const accept = container.querySelector(
        '[data-qa="lead-fact-accept"]',
      ) as HTMLButtonElement | null;
      expect(accept).not.toBeNull();

      act(() => {
        accept?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(state.mutate).toHaveBeenCalledWith({
        factId: 'fact-42',
        decision: 'ACCEPT',
      });
    });

    it('dismissing sends DISMISS', () => {
      state.facts = [fact({ id: 'fact-7' })];
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      act(() => {
        root?.render(<LeadFactsPanel leadId="lead-1" />);
      });

      const dismiss = container.querySelector(
        '[data-qa="lead-fact-dismiss"]',
      ) as HTMLButtonElement | null;
      expect(dismiss).not.toBeNull();

      act(() => {
        dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(state.mutate).toHaveBeenCalledWith({
        factId: 'fact-7',
        decision: 'DISMISS',
      });
    });
  });
});
