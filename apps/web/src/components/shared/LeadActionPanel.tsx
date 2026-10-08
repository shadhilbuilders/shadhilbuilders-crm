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
// LOST and RNR transitions require a `reason` (audit policy); the form
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
import { TRANSITIONS, reopenTargetsFor, splitTransitions } from '@/lib/lead-transitions';

export { allowedTransitionsFor } from '@/lib/lead-transitions';
import {
  LuBookOpen,
  LuCalendarCheck,
  LuCalendarPlus,
  LuCalendarX2,
  LuCircleX,
  LuHandshake,
  LuMapPin,
  LuMoon,
  LuPhoneIncoming,
  LuRotateCcw,
  LuTrophy,
  LuUserPlus,
} from '@paalstack/react-icons/lu';

const STATES_REQUIRING_REASON: ReadonlySet<string> = new Set(['LOST', 'RNR']);

/**
 * A semantic icon for each lead state, used on the transition buttons so a
 * user can scan the actions without reading every label. Keys mirror the
 * backend-state machine state names (leads.state-machine.ts).
 */
// Exported for `lead-state-icon-coverage.test.tsx` so a newly added
// LeadState cannot ship with a silently-iconless transition button.
export const STATE_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  // Forward motions
  NEW: LuUserPlus, // back to a fresh lead
  CONTACTED: LuPhoneIncoming, // first contact / follow-up call
  VISIT_REQUESTED: LuCalendarPlus, // ask to schedule
  VISIT_SCHEDULED: LuCalendarCheck, // confirmed slot
  VISITED: LuMapPin, // on-site visit
  NEGOTIATION: LuHandshake, // deal negotiation
  BOOKING_INITIATED: LuBookOpen, // booking opened
  WON: LuTrophy, // closed-won
  // Rejection / pause
  RNR: LuMoon, // gone quiet - no response to contact attempts
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
  const reopenTargets = reopenTargetsFor(status, user?.role);
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
          <TransitionLeadForm
            leadId={lead.id}
            outgoing={reopenTargets.length > 0 ? reopenTargets : outgoing}
            status={status}
            reopen={reopenTargets.length > 0}
          />
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
  reopen = false,
}: {
  leadId: string;
  outgoing: readonly string[];
  status: string;
  /** Admin reopening a terminal lead: targets are reopen choices, reason required. */
  reopen?: boolean;
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

  const requiresReason =
    toState !== null && (reopen || STATES_REQUIRING_REASON.has(toState));

  function onSubmit(target: string) {
    const body: LeadStateTransitionDto = {
      leadId,
      toState: target as LeadStateTransitionDto['toState'],
    };
    if (reopen || STATES_REQUIRING_REASON.has(target)) {
      const r = reason.trim();
      if (r.length === 0) {
        toast.error(
          reopen
            ? 'Reason is required to reopen a closed lead'
            : `Reason is required when transitioning to ${labelFor('lead', target)}`,
        );
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
  const { forward, back } = reopen
    ? { forward: outgoing, back: [] as readonly string[] }
    : splitTransitions(status, outgoing);

  function renderTargetButton(target: string, text: string) {
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
        {text}
      </Button>
    );
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {reopen ? 'Reopen as' : 'Transition'}
      </div>

      {toState === null ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {forward.map((target) => renderTargetButton(target, labelFor('lead', target)))}
          </div>
          {back.length > 0 ? (
            <div className="space-y-1" data-qa="transition-move-back">
              <div className="text-muted-foreground text-xs">Move back</div>
              <div className="flex flex-wrap gap-2">
                {back.map((target) =>
                  renderTargetButton(target, `Back to ${labelFor('lead', target)}`),
                )}
              </div>
            </div>
          ) : null}
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
