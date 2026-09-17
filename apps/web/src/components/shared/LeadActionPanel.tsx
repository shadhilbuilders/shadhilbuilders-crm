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

import { useState, type ComponentType } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Form,
  Label,
  Textarea,
  toast,
} from '@paalstack/react-ui';

import type { UpdateLeadDto, LeadStateTransitionDto } from '@shadhil/api-types';

import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { LeadReassignDialog } from '@/components/leads/LeadReassignDialog';
import { LeadCoOwnerDialog } from '@/components/leads/LeadCoOwnerDialog';
import { useTransitionLead, useUpdateLead } from '@/hooks/queries/crm';
import { canReassign, useSessionUser } from '@/lib/session';
import { labelFor } from '@/lib/labels';
import {
  LuBookOpen,
  LuCalendarCheck,
  LuCalendarPlus,
  LuCalendarX2,
  LuCircleX,
  LuHandshake,
  LuMapPin,
  LuPhoneIncoming,
  LuRotateCcw,
  LuSnowflake,
  LuTrophy,
} from '@paalstack/react-icons/lu';

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

/**
 * The one edge the visit handoff reserves (2026-09-16 owner ruling).
 *
 * The handoff happens while the lead is still VISIT_SCHEDULED: the assigned
 * SALES_EXEC records the visit as COMPLETED and the server drives
 * VISIT_SCHEDULED → VISITED (visits.service.ts, "Drive the parent lead state
 * on COMPLETED"). So this edge belongs to the exec, NOT to the telecaller -
 * even though VISIT_SCHEDULED is otherwise the telecaller's state.
 *
 * The mirror has to encode this because the telecaller lane reuses the raw
 * TRANSITIONS list for its states, so simply rendering `TRANSITIONS[status]`
 * would offer a telecaller a "Visited" button the server answers 403 for.
 * Mirrors HANDOFF_FROM/HANDOFF_TO in the backend state machine.
 */
const HANDOFF_FROM = 'VISIT_SCHEDULED';
const HANDOFF_TO = 'VISITED';

/** Outgoing edges for `role` at `status`, per the server's role gates. */
export function allowedTransitionsFor(status: string, role: string): readonly string[] {
  const outgoing: readonly string[] = TRANSITIONS[status] ?? [];
  const isTelecallerLane = TELECALLER_LANE.includes(status);
  const isExecLane = EXEC_LANE.includes(status);
  const isHandoffEdge = (to: string) => status === HANDOFF_FROM && to === HANDOFF_TO;

  if (role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER') {
    // Managers and admins drive any non-terminal edge; terminal states have
    // no outgoing edges for them.
    return outgoing;
  }
  if (role === 'TELECALLER') {
    if (!isTelecallerLane) return [];
    return outgoing.filter((to) => !isHandoffEdge(to));
  }
  if (role === 'SALES_EXEC') {
    if (isExecLane) return outgoing;
    // The exec's one out-of-lane edge: completing the visit they conducted.
    return outgoing.filter(isHandoffEdge);
  }
  return [];
}

const TELECALLER_LANE: readonly string[] = [
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'RESCHEDULED',
  'NO_SHOW',
];

const EXEC_LANE: readonly string[] = ['VISITED', 'NEGOTIATION', 'BOOKING_INITIATED'];

/**
 * A semantic icon for each lead state, used on the transition buttons so a
 * user can scan the actions without reading every label. Keys mirror the
 * backend-state machine state names (leads.state-machine.ts).
 */
const STATE_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  // Forward motions
  CONTACTED: LuPhoneIncoming, // first contact / follow-up call
  VISIT_REQUESTED: LuCalendarPlus, // ask to schedule
  VISIT_SCHEDULED: LuCalendarCheck, // confirmed slot
  VISITED: LuMapPin, // on-site visit
  NEGOTIATION: LuHandshake, // deal negotiation
  BOOKING_INITIATED: LuBookOpen, // booking opened
  WON: LuTrophy, // closed-won
  // Rejection / pause
  COLD: LuSnowflake, // deprioritized
  LOST: LuCircleX, // closed-lost
  // Re-engagement loop
  RESCHEDULED: LuRotateCcw, // reschedule visit
  NO_SHOW: LuCalendarX2, // missed appointment
};

type LeadData = {
  id: string;
  name?: string;
  email?: string | null;
  status?: string;
  ownerId?: string;
  coOwnerId?: string | null;
  /** Optional: the dialogs fall back to the active project when omitted. */
  projectId?: string | null;
};

export function LeadActionPanel({ lead }: { lead: LeadData }) {
  const status = typeof lead.status === 'string' ? lead.status : 'NEW';
  const outgoing = TRANSITIONS[status] ?? [];
  const { user } = useSessionUser();
  const canAssign = user !== null && canReassign(user.role);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [coOwnerOpen, setCoOwnerOpen] = useState(false);

  return (
    <>
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
          {canAssign ? (
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReassignOpen(true)}
                data-qa="lead-reassign-open"
              >
                Assign to...
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCoOwnerOpen(true)}
                data-qa="lead-co-owner-open"
              >
                Co-owner...
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <LeadReassignDialog
        lead={{ id: lead.id, name: lead.name ?? 'lead', projectId: lead.projectId ?? null }}
        currentOwnerId={lead.ownerId ?? ''}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
      />
      <LeadCoOwnerDialog
        lead={{
          id: lead.id,
          name: lead.name ?? 'lead',
          ownerId: lead.ownerId ?? '',
          projectId: lead.projectId ?? null,
        }}
        currentCoOwnerId={lead.coOwnerId ?? null}
        open={coOwnerOpen}
        onOpenChange={setCoOwnerOpen}
      />
    </>
  );
}

// Client-side validation for the inline edit form. Mirrors the server's
// UpdateLeadDto contract (packages/api-types/src/leads.ts): name required
// (≤120), email optional but must be a valid email when present. The
// server remains the source of truth - a 400/409 surfaces verbatim.
const editLeadSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name must be 120 characters or fewer'),
  email: z
    .string()
    .trim()
    .max(254, 'Email must be 254 characters or fewer')
    .refine((v) => v.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Enter a valid email address',
    })
    .optional(),
});

type EditLeadFormValues = z.infer<typeof editLeadSchema>;

function EditLeadForm({ lead }: { lead: LeadData }) {
  const updateLead = useUpdateLead(lead.id);
  const initialName = typeof lead.name === 'string' ? lead.name : '';
  const initialEmail = typeof lead.email === 'string' ? lead.email : '';

  const form = useForm<EditLeadFormValues>({
    resolver: zodResolver(editLeadSchema),
    defaultValues: {
      name: initialName,
      email: initialEmail,
    },
    mode: 'onSubmit',
  });

  function onSave(values: EditLeadFormValues) {
    const body: UpdateLeadDto = { id: lead.id };
    if (values.name.trim() !== initialName) body.name = values.name.trim();
    if (values.email !== undefined && values.email.trim() !== initialEmail) {
      if (values.email.trim().length > 0) {
        body.email = values.email.trim().toLowerCase();
      } else if (initialEmail.length > 0) {
        // Allow clearing email by setting empty.
        body.email = '';
      }
    }
    updateLead.mutate(body, {
      onSuccess: () => {
        toast.success('Lead updated');
        form.reset({ name: values.name.trim(), email: values.email?.trim() ?? '' });
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
    });
  }

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Edit
      </div>
      <Form
        form={form}
        onSubmit={onSave}
        submitText={updateLead.isPending ? 'Saving...' : 'Save'}
        submitButtonProps={{
          size: 'sm',
          disabled: updateLead.isPending,
          'data-qa': 'edit-lead-save',
        }}
        actionClassName="justify-end col-span-2"
        className="grid grid-cols-1 sm:grid-cols-2 gap-x-2 space-y-2 sm:gap-x-4"
        hideResetButton
        fields={[
          {
            type: 'input',
            name: 'name',
            label: 'Name',
            required: true,
            placeholder: 'Enter full name',
            inputProps: {
              maxLength: 120,
              'data-qa': 'edit-lead-name',
              autoComplete: 'name',
            },
          },
          {
            type: 'input',
            name: 'email',
            label: 'Email',
            inputType: 'email',
            placeholder: 'Enter email address',
            description: 'Optional. Used for booking confirmations.',
            inputProps: {
              'data-qa': 'edit-lead-email',
              autoComplete: 'email',
            },
          },
        ]}
      />
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

  const ConfirmIcon = toState !== null ? STATE_ICONS[toState] : undefined;

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Transition
      </div>

      {toState === null ? (
        <div className="flex flex-wrap gap-2">
          {outgoing.map((target) => {
            const Icon = STATE_ICONS[target];
            return (
              <Button
                key={target}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setToState(target)}
                data-qa={`transition-to-${target}`}
                className="gap-1.5"
              >
                {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {labelFor('lead', target)}
              </Button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            Move from <LeadStatusBadge status={status} /> to{' '}
            <LeadStatusBadge status={toState} />
          </div>

          {requiresReason ? (
            <div className="flex flex-col gap-2">
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

          <div className="flex flex-col gap-2">
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
              {transitionLead.isPending ? (
                'Saving...'
              ) : (
                <>
                  {ConfirmIcon ? (
                    <ConfirmIcon className="h-4 w-4" aria-hidden="true" />
                  ) : null}
                  <span>Confirm {labelFor('lead', toState)}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
