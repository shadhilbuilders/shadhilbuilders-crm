'use client';

// T-LEAD-FACTS (2026-11-05): the lead's fact ledger, on the lead detail page.
//
// Two things are shown, and they are different questions:
//   - SUGGESTIONS: a source said something that disagrees with the record. The
//     rep decides. Accepting writes the lead; dismissing means it is never
//     offered again.
//   - ON THE RECORD: the values that came from a fact, with the reason they are
//     believed. This is what lets somebody tell "the customer confirmed it" from
//     "it was typed once".
//
// The panel renders nothing when there is no ledger activity, so a lead that
// has never been observed looks exactly as it did before.
import { Badge, Button } from '@paalstack/react-ui';

import { useDecideLeadFact, useLeadFacts } from '@/hooks/queries/crm';
import { factBandBadgeVariant, labelFor } from '@/lib/labels';
import type { LeadFactField, LeadFactRow } from '@shadhil/api-types';

const FIELD_LABELS: Record<LeadFactField, string> = {
  name: 'Name',
  email: 'Email',
  source: 'Source',
};

export function LeadFactsPanel({ leadId }: { leadId: string | null }) {
  const factsQuery = useLeadFacts(leadId);
  const decide = useDecideLeadFact(leadId);

  const facts = factsQuery.data?.facts ?? [];
  if (facts.length === 0) return null;

  const suggestions = facts.filter((fact) => fact.status === 'PROPOSED');
  const applied = facts.filter((fact) => fact.status === 'APPLIED');

  return (
    <div className="flex flex-col gap-4" data-qa="lead-facts">
      {suggestions.length > 0 ? (
        <section
          className="border-warning/40 bg-warning-soft/40 flex flex-col gap-2 rounded-md border p-3"
          data-qa="lead-fact-suggestions"
        >
          <h3 className="text-sm font-medium">
            {suggestions.length === 1
              ? 'One suggestion needs a decision'
              : `${suggestions.length} suggestions need a decision`}
          </h3>
          {suggestions.map((fact) => (
            <SuggestionRow
              key={fact.id}
              fact={fact}
              busy={decide.isPending}
              onDecide={(decision) => decide.mutate({ factId: fact.id, decision })}
            />
          ))}
        </section>
      ) : null}

      {applied.length > 0 ? (
        <section className="flex flex-col gap-2" data-qa="lead-fact-applied">
          <h3 className="text-sm font-medium">Where these values came from</h3>
          {applied.map((fact) => (
            <div
              key={fact.id}
              className="flex flex-wrap items-center gap-2 text-sm"
              data-qa="lead-fact-applied-row"
              data-field={fact.field}
            >
              <span className="text-muted-foreground">{FIELD_LABELS[fact.field]}</span>
              <span className="font-medium">{fact.value}</span>
              <Badge variant={factBandBadgeVariant(fact.band)}>
                {labelFor('factBand', fact.band)}
              </Badge>
              <span className="text-muted-foreground">{fact.rationale}</span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function SuggestionRow({
  fact,
  busy,
  onDecide,
}: {
  fact: LeadFactRow;
  busy: boolean;
  onDecide: (decision: 'ACCEPT' | 'DISMISS') => void;
}) {
  return (
    <div
      className="border-warning/30 flex flex-col gap-1 border-t pt-2 first:border-t-0 first:pt-0"
      data-qa="lead-fact-suggestion"
      data-field={fact.field}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{FIELD_LABELS[fact.field]}</span>
        <span className="font-medium">{fact.value}</span>
        <Badge variant={factBandBadgeVariant(fact.band)}>{labelFor('factBand', fact.band)}</Badge>
      </div>
      <p className="text-muted-foreground text-sm">{fact.rationale}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          data-qa="lead-fact-accept"
          onClick={() => onDecide('ACCEPT')}
        >
          Use this
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          data-qa="lead-fact-dismiss"
          onClick={() => onDecide('DISMISS')}
        >
          No
        </Button>
      </div>
    </div>
  );
}
