'use client';

// LeadActionPanel - bottom-of-detail action surface for a single lead.
//
// Two actions:
//   1. Edit name/email (PATCH /leads/:id - name + email only per
//      LeadUpdateDto; everything else goes through dedicated endpoints).
//   2. Transition state (POST /leads/:id/transition).
//
// Transitions are listed from the LOCAL mirror of the Model C state
// machine in apps/backend/src/leads/leads.state-machine.ts. We expose
// ALL outgoing edges for the current state; the server enforces role
// gating (canRoleTransition) and rejects with 403 ROLE_FORBIDDEN if the
// current user can't perform a given transition. This avoids duplicating
// the role table on the frontend.
//
// LOST and COLD transitions require a `reason` (audit policy); the form
// prompts for it inline. Other transitions allow an optional `notes`
// field (e.g. "Discussed 3BHK options with the couple over WhatsApp").
//
// Lives next to LeadStatusBadge because both are leads-list/detail
// helpers that don't belong in the page file itself (Next.js 16's page
// module allow-list is strict).

import { useState } from 'react';

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
  toast,
} from '@paalstack/react-ui';

import type { UpdateLeadDto, LeadStateTransitionDto } from '@shadhil/api-types';

import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { useTransitionLead, useUpdateLead } from '@/hooks/queries/crm';
import { labelFor } from '@/lib/labels';

/**
 * Local mirror of the backend Model C transition table. Mirrored here
 * (not imported from the backend) because the backend file lives in
 * `apps/backend/src/leads/leads.state-machine.ts` and is NOT a published
 * package - importing across workspace boundaries would violate the
 * monorepo direction (apps/backend may not be consumed by apps/web).
 *
 * Source of truth: apps/backend/src/leads/leads.state-machine.ts:48-72.
 * Drift here means the user sees a button the server will reject - the
 * server still wins. Re-verify on every backend state-machine change.
 */
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  NEW: ['CONTACTED', 'VISIT_REQUESTED', 'COLD', 'LOST'],
  CONTACTED: ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'COLD', 'LOST'],
  VISIT_REQUESTED: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
  VISIT_SCHEDULED: ['VISITED', 'NO_SHOW', 'RESCHEDULED', 'COLD', 'LOST'],
  VISITED: ['NEGOTIATION', 'VISIT_REQUESTED', 'COLD', 'LOST'],
  NEGOTIATION: ['BOOKING_INITIATED', 'VISIT_REQUESTED', 'COLD', 'LOST'],
  BOOKING_INITIATED: ['WON', 'NEGOTIATION', 'COLD', 'LOST'],
  WON: [],
  LOST: [],
  COLD: [],
  NO_SHOW: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
  RESCHEDULED: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
};

const STATES_REQUIRING_REASON: ReadonlySet<string> = new Set(['LOST', 'COLD']);

type LeadData = {
  id: string;
  name?: string;
  email?: string;
  status?: string;
};

export function LeadActionPanel({ lead }: { lead: LeadData }) {
  const status = typeof lead.status === 'string' ? lead.status : 'NEW';
  const outgoing = TRANSITIONS[status] ?? [];

  return (
    <Card data-qa="lead-action-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Actions
          <LeadStatusBadge status={status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <EditLeadForm lead={lead} />
        <TransitionLeadForm leadId={lead.id} outgoing={outgoing} status={status} />
      </CardContent>
    </Card>
  );
}

function EditLeadForm({ lead }: { lead: LeadData }) {
  const updateLead = useUpdateLead(lead.id);
  const initialName = typeof lead.name === 'string' ? lead.name : '';
  const initialEmail = typeof lead.email === 'string' ? lead.email : '';
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const dirty = name !== initialName || email !== initialEmail;

  function onSave() {
    if (!dirty) return;
    const body: UpdateLeadDto = { id: lead.id };
    if (name.trim().length > 0 && name !== initialName) body.name = name.trim();
    if (email.trim().length > 0 && email !== initialEmail) {
      body.email = email.trim().toLowerCase();
    } else if (email.trim().length === 0 && initialEmail.length > 0) {
      // Allow clearing email by setting empty
      body.email = '';
    }
    updateLead.mutate(body, {
      onSuccess: () => toast.success('Lead updated'),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
    });
  }

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Edit
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor={`lead-name-${lead.id}`}>Name</Label>
          <Input
            id={`lead-name-${lead.id}`}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={120}
            data-qa="edit-lead-name"
          />
        </div>
        <div>
          <Label htmlFor={`lead-email-${lead.id}`}>Email</Label>
          <Input
            id={`lead-email-${lead.id}`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            data-qa="edit-lead-email"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={onSave}
          disabled={!dirty || updateLead.isPending}
          data-qa="edit-lead-save"
        >
          {updateLead.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function TransitionLeadForm({
  leadId,
  outgoing,
  status,
}: {
  leadId: string;
  outgoing: readonly string[];
  status: string;
}) {
  const transitionLead = useTransitionLead(leadId);
  const [toState, setToState] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  if (outgoing.length === 0) {
    return (
      <div className="text-muted-foreground text-xs">
        No transitions available from <strong>{labelFor('lead', status)}</strong>{' '}
        (terminal state).
      </div>
    );
  }

  const requiresReason = toState !== null && STATES_REQUIRING_REASON.has(toState);

  function onSubmit(target: string) {
    const body: LeadStateTransitionDto = {
      leadId,
      toState: target as LeadStateTransitionDto['toState'],
    };
    if (STATES_REQUIRING_REASON.has(target)) {
      const r = reason.trim();
      if (r.length === 0) {
        toast.error(`Reason is required when transitioning to ${labelFor('lead', target)}`);
        return;
      }
      body.reason = r;
    }
    if (notes.trim().length > 0) body.notes = notes.trim();
    transitionLead.mutate(body, {
      onSuccess: () => {
        toast.success(`Lead moved to ${labelFor('lead', target)}`);
        setToState(null);
        setReason('');
        setNotes('');
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : 'Transition failed';
        toast.error(msg);
      },
    });
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Transition
      </div>

      {toState === null ? (
        <div className="flex flex-wrap gap-2">
          {outgoing.map((target) => (
            <Button
              key={target}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setToState(target)}
              data-qa={`transition-to-${target}`}
            >
              → {labelFor('lead', target)}
            </Button>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            Move from <LeadStatusBadge status={status} /> to{' '}
            <LeadStatusBadge status={toState} />
          </div>

          {requiresReason ? (
            <div>
              <Label htmlFor={`reason-${leadId}-${toState}`}>
                Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id={`reason-${leadId}-${toState}`}
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
                maxLength={500}
                rows={2}
                placeholder="e.g. price too high, competitor chosen, unresponsive after 3 follow-ups"
                data-qa="transition-reason"
              />
            </div>
          ) : null}

          <div>
            <Label htmlFor={`notes-${leadId}-${toState}`}>Notes (optional)</Label>
            <Textarea
              id={`notes-${leadId}-${toState}`}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              maxLength={2000}
              rows={2}
              placeholder="What happened on this transition?"
              data-qa="transition-notes"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setToState(null);
                setReason('');
                setNotes('');
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => onSubmit(toState)}
              disabled={transitionLead.isPending}
              data-qa="transition-confirm"
            >
              {transitionLead.isPending ? 'Saving…' : `Confirm → ${labelFor('lead', toState)}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
