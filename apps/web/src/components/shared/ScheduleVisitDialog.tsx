'use client';

// ScheduleVisitDialog - form for creating a site visit.
//
// Used inside the visits page (Schedule button) and inside the lead
// detail page (when the lead is in VISIT_REQUESTED / VISIT_SCHEDULED).
// Fields match the CreateSiteVisitDto Zod schema in
// packages/api-types/src/visits.ts - the server validates the same
// shape and surfaces errors verbatim via toast.
//
// scheduledFor is required (must be in the future per the Zod refine);
// salesExecId is optional (defaults to actor.sub on the server).
//
// T-DASH-QUEUE (2026-09-16) - TELECALLER FIX. Two things blocked a telecaller
// from scheduling a visit at all, both verified against the running server:
//   1. `visits.service.create` sets `userId = dto.salesExecId ?? actor.sub`
//      (visits.service.ts:245) and then rejects any assignee that is not
//      SALES_EXEC-or-higher (:255-264). A telecaller who leaves the exec blank
//      therefore gets a 400: "Visit assignee must be SALES_EXEC or higher
//      (got TELECALLER)". Omitting the exec is not a valid path for them.
//   2. The exec picker is fed by `/users/project/:id/sales-execs`, which
//      returns [] for TELECALLER (users.service.ts:1011-1013) - so the picker
//      was EMPTY and there was no way to fill the field in.
// Fix: for a telecaller, source the picker from `/users/team` (staff scope =
// team + manager, already powering the chat @mention picker) filtered to
// SALES_EXEC/MANAGER, and make the field REQUIRED so a blank submit - which
// would 400 - is impossible. No backend change: supplying a valid salesExecId
// passes the existing assignee check.
import { useEffect, useMemo } from 'react';

import type { FormFieldItemType } from '@paalstack/react-ui';
import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import { useCreateVisit, useLeads } from '@/hooks/queries/crm';
import { useProjectId } from '@/lib/tenant-context';
import { useProjectSalesExecs, useTeamMembers } from '@/hooks/queries/users';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { labelFor } from '@/lib/labels';
import { SCHEDULABLE_LEAD_STATES } from '@shadhil/api-types';

// The lead states that can accept a site visit come from
// `@shadhil/api-types` (SCHEDULABLE_LEAD_STATES), NOT a local copy: the server
// guard, this picker and the queue's row-action matrix all read the same list.
// They were three copies until 2026-09-30, and they disagreed - this picker and
// the queue offered a NO_SHOW lead while the server answered 400.
// Listing the states is still the point: the picker must never offer a lead the
// create would reject.

// Client-side validation mirroring CreateSiteVisitDtoSchema in
// packages/api-types/src/visits.ts. The date/time are separate HTML inputs
// (yyyy-MM-dd / HH:mm); we combine them and refine that the resulting
// datetime is in the future (same rule the server enforces).
const scheduleVisitSchema = z
  .object({
    leadId: z.string().min(1, 'Please select a lead'),
    scheduledForDate: z.string().min(1, 'Date is required'),
    scheduledForTime: z.string().min(1, 'Time is required'),
    salesExecId: z.string().optional(),
    notes: z.string().max(2000, 'Notes must be less than 2000 characters').trim().optional(),
  })
  .refine(
    (data) => {
      const dt = new Date(`${data.scheduledForDate}T${data.scheduledForTime}:00`);
      return !Number.isNaN(dt.getTime()) && dt.getTime() > Date.now();
    },
    { message: 'scheduledFor must be in the future', path: ['scheduledForDate'] },
  );

type FormValues = z.infer<typeof scheduleVisitSchema>;

type ScheduleVisitDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Pre-select a lead (e.g. from the lead detail page). */
  initialLeadId?: string;
  /** Pre-fill the date/time (e.g. from a calendar slot click). */
  initialDate?: Date;
  /** Hide the lead picker when a lead is pre-selected. */
  hideLeadPicker?: boolean;
  /** Called after a successful create with the new visit row. */
  onCreated?: () => void;
  /**
   * Called with the visit's scheduled time, so a DATE-SCOPED view (the calendar)
   * can centre itself on the date the user just booked.
   *
   * WHY THIS EXISTS: the calendar renders only the period it is showing, so a
   * visit dated outside it is invisible right after creation - the user schedules,
   * sees nothing change, and reasonably concludes the create failed.
   *
   * Gives the DATE, not a week-start: rounding to a week here (in the dialog) would
   * be wrong for the agenda view, which is scoped to a MONTH. A week containing the
   * 1st belongs to the previous month, so a week-rounded view would show the wrong
   * month - the `onScheduledDate` receiver decides how to represent the date.
   *
   * Optional: callers with no date-scoped view (the lead panel, the dashboard's
   * today card) omit it and nothing changes for them.
   */
  onScheduledDate?: (scheduledFor: Date) => void;
};

export function ScheduleVisitDialog({
  open,
  onOpenChange,
  initialLeadId,
  initialDate,
  hideLeadPicker = false,
  onCreated,
  onScheduledDate,
}: ScheduleVisitDialogProps) {
  const createVisit = useCreateVisit();
  const { user } = useSessionUser();
  // NOT useParams<{projectId}>(): the route is
  // /[orgSlug]/projects/[projectSlug]/... so there is no `projectId` param and
  // this was permanently undefined, which silently disabled the exec query
  // (`enabled: projectId !== undefined`). The tenant context resolves the ACTIVE
  // project properly and is what the rest of the app uses.
  const projectIdFromContext = useProjectId();
  const projectId = projectIdFromContext ?? undefined;

  // Only fetch leads that can actually accept a visit (see
  // SCHEDULABLE_LEAD_STATES) so the picker never offers a lead that
  // the server will reject.
  const leadsQuery = useLeads({ limit: 100, state: [...SCHEDULABLE_LEAD_STATES] });

  // Sales execs for this project, resolved server-side by role:
  //   - MANAGER: execs in the manager's own team who own leads in this project.
  //   - ADMIN/OWNER: all SALES_EXEC who own leads in this project.
  const isAdminOrOwner = user === null ? false : isAdminLike(user.role);
  const isManager = user !== null && user.role === 'MANAGER';
  const isTelecaller = user !== null && user.role === 'TELECALLER';
  const showExecPicker = isAdminOrOwner || isManager || isTelecaller;

  // Two different sources on purpose (see the T-DASH-QUEUE note at the top):
  // MANAGER/ADMIN use the project-scoped endpoint, but a TELECALLER must use the
  // team endpoint - the project-scoped one returns [] for them, which is why
  // their picker used to be empty with no way to proceed.
  const projectSalesExecsQuery = useProjectSalesExecs(projectId);
  const teamMembersQuery = useTeamMembers();
  const salesExecOptions = useMemo(() => {
    const asOption = (u: { id: string; name: string; role: string }) => ({
      value: u.id,
      label: `${u.name}${u.role === 'MANAGER' ? ' (manager)' : ''}`,
    });

    if (!showExecPicker) return [];

    // Only roles the SERVER will accept as a visit assignee (SALES_EXEC or
    // higher). Offering a fellow telecaller would produce a 400.
    const assignable = (rows: unknown) =>
      Array.isArray(rows)
        ? (rows as { id: string; name: string; role: string }[]).filter(
            (u) => u.role === 'SALES_EXEC' || u.role === 'MANAGER',
          )
        : [];

    const fromProject = assignable(projectSalesExecsQuery.data);

    // The project-scoped list is fed by STAFFING on the project, but it can
    // still be empty (no team linked yet). Falling back to the actor's team
    // keeps the field usable instead of dead-ending the whole dialog on a
    // project whose staffing is incomplete.
    const source = fromProject.length > 0 ? fromProject : assignable(teamMembersQuery.data);
    return source.map(asOption);
  }, [
    showExecPicker,
    teamMembersQuery.data,
    projectSalesExecsQuery.data,
  ]);

  // A telecaller CANNOT omit the exec: the server falls back to the actor and
  // then rejects a TELECALLER assignee with a 400. So required for them, and
  // only for them - a manager's blank field legitimately means "me".
  const execRequired = isTelecaller;

  // When a lead is preselected AND the form has a real value for it, hide the
  // picker: from the work queue the telecaller clicked a specific lead, so
  // asking them to find that same lead again in a dropdown is busywork. Falls
  // back to showing the picker when there is nothing preselected.
  const hideLeadPickerEffective = hideLeadPicker || (initialLeadId ?? '').length > 0;

  // The exec field's rule has to be built per role, so the resolver schema is
  // derived from the module-scope one rather than forked.
  const schema = useMemo(
    () =>
      execRequired
        ? scheduleVisitSchema.refine((v) => (v.salesExecId ?? '').length > 0, {
            message: 'Select the sales exec who will attend',
            path: ['salesExecId'],
          })
        : scheduleVisitSchema,
    [execRequired],
  );

  // Default to tomorrow at 10am - gives the user a sensible starting
  // point while still requiring them to confirm the date. When a calendar
  // slot is clicked, `initialDate` pre-fills the exact date/time instead.
  const defaultDate = useMemo(() => {
    if (initialDate !== undefined) {
      return initialDate.toISOString().slice(0, 10);
    }
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [initialDate]);

  const defaultTime = useMemo(() => {
    if (initialDate !== undefined) {
      return `${String(initialDate.getHours()).padStart(2, '0')}:${String(
        initialDate.getMinutes(),
      ).padStart(2, '0')}`;
    }
    return '10:00';
  }, [initialDate]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      leadId: initialLeadId ?? '',
      scheduledForDate: defaultDate,
      scheduledForTime: defaultTime,
      salesExecId: '',
      notes: '',
    },
    mode: 'onSubmit',
  });

  // Re-seed on open: `defaultValues` is only read at mount, so a dialog whose
  // `initialLeadId` changes (the queue opens it for a different lead each time)
  // would otherwise keep the FIRST lead forever. This is the bug that made the
  // preselected-lead flow unusable.
  useEffect(() => {
    if (!open) return;
    form.reset({
      leadId: initialLeadId ?? '',
      scheduledForDate: defaultDate,
      scheduledForTime: defaultTime,
      salesExecId: '',
      notes: '',
    });
  }, [open, initialLeadId, defaultDate, defaultTime, form]);

  const leadOptions = useMemo(() => {
    const rows = leadsQuery.data;
    if (rows === undefined || !Array.isArray(rows)) return [];
    return rows.map((r) => {
      const row = r as { id: string; name?: string; status?: string };
      const statusLabel =
        typeof row.status === 'string' ? labelFor('lead', row.status) : '';
      return {
        value: row.id,
        label: `${row.name ?? 'Lead'}${statusLabel.length > 0 ? ` (${statusLabel})` : ''}`,
      };
    });
  }, [leadsQuery.data]);

  function onSubmit(values: FormValues) {
    // zodResolver already validated leadId + the future-datetime refine, so
    // no manual checks needed here. Combine date + time into an ISO datetime
    // with the user's local timezone offset.
    const localDateTime = new Date(
      `${values.scheduledForDate}T${values.scheduledForTime}:00`,
    );

    const payload: {
      leadId: string;
      scheduledFor: string;
      salesExecId?: string;
      notes?: string;
    } = {
      leadId: values.leadId,
      scheduledFor: localDateTime.toISOString(),
    };
    if (values.salesExecId !== undefined && values.salesExecId.length > 0) {
      payload.salesExecId = values.salesExecId;
    }
    if (values.notes !== undefined && values.notes.trim().length > 0) {
      payload.notes = values.notes.trim();
    }

    createVisit.mutate(payload, {
      onSuccess: () => {
        toast.success('Visit scheduled');
        form.reset();
        onOpenChange(false);
        // Hand the view the booked date BEFORE it refetches, so a date-scoped
        // view (the calendar) can move to it. Without this the calendar stays on
        // its current month and the new visit renders off-screen, which reads as
        // a failed create.
        if (onScheduledDate !== undefined) onScheduledDate(localDateTime);
        if (onCreated !== undefined) onCreated();
      },
      onError: (e) => {
        toast.error(e instanceof Error ? e.message : 'Schedule failed');
      },
    });
  }

  const fields = [
    ...(hideLeadPickerEffective
      ? []
      : [
          {
            type: 'combobox' as const,
            name: 'leadId',
            label: 'Lead',
            required: true,
            options: leadOptions,
            placeholder: 'Search a lead...',
            comboboxProps: {
              emptyOptionMessage: 'No schedulable leads found',
              'data-qa': 'schedule-visit-lead',
              selectOptionAsValue: true,
            },
          },
        ]),
    {
      type: 'input' as const,
      name: 'scheduledForDate',
      label: 'Date',
      required: true,
      inputType: 'date',
      inputProps: { 'data-qa': 'schedule-visit-date' },
    },
    {
      type: 'input' as const,
      name: 'scheduledForTime',
      label: 'Time',
      required: true,
      inputType: 'time',
      inputProps: { 'data-qa': 'schedule-visit-time' },
    },
    ...(showExecPicker
      ? [
          {
            type: 'combobox' as const,
            name: 'salesExecId',
            // Required for a telecaller (see T-DASH-QUEUE note at top): the
            // server rejects a TELECALLER assignee, so a blank field would 400.
            // For MANAGER/ADMIN blank legitimately means "me", so optional.
            label: execRequired ? 'Sales exec attending' : 'Sales exec (optional)',
            required: execRequired,
            options: salesExecOptions,
            placeholder: 'Search a sales exec...',
            comboboxProps: {
              emptyOptionMessage:
                'No sales exec available - add one to a team on this project',
              'data-qa': 'schedule-visit-sales-exec',
              selectOptionAsValue: true,
            },
          },
        ]
      : []),
    {
      type: 'textarea' as const,
      name: 'notes',
      label: 'Notes',
      placeholder: 'Customer requested morning slot; bring project brochure.',
      textareaProps: { rows: 3, maxLength: 2000 },
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{ title: 'Schedule a site visit' }}
      contentClassName='sm:max-w-lg'
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="schedule-visit-form"
            isLoading={createVisit.isPending}
            loadingText="Scheduling..."
            data-qa="schedule-visit-submit"
          >
            Schedule
          </Button>
        </div>
      }
      open={open}
      onOpenChange={onOpenChange}
    >
      <Form
        id="schedule-visit-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields as FormFieldItemType<FormValues>[]}
      />
    </Dialog>
  );
}
