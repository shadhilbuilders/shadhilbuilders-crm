'use client';

// RescheduleVisitDialog - move an existing site visit to a new date/time.
//
// WHY IT EXISTS (2026-09-29, owner request: "give option to reschedule" on the
// visit detail dialog). The calendar already had drag-and-drop reschedule, but
// that is a mouse-only gesture on a grid: it is invisible (nothing says the
// event is draggable), unavailable to a keyboard user, and unusable from the
// agenda view the page now defaults to. A real control was missing.
//
// IT IS A SIBLING OF ScheduleVisitDialog ON PURPOSE, not a variant of it. The
// two hit different endpoints with different DTOs (`POST /api/visits` vs
// `PATCH /api/visits/:id/reschedule`), and reschedule must NOT offer a lead
// picker: the lead is fixed by the visit being moved. Forking the create form
// would have meant a `mode` prop threaded through every field - the
// over-configuration the component guidelines warn about - so this is a small
// dedicated form instead.
//
// WHAT THE SERVER ENFORCES (packages/api-types/src/visits.ts RescheduleVisitDto):
//   - `scheduledFor` must be in the FUTURE (Zod refine).
//   - the visit must currently be SCHEDULED or NO_SHOW (visits.service.reschedule);
//     anything else is a 400, which is why the caller only offers this for those
//     two statuses.
import { useEffect, useMemo } from 'react';

import type { FormFieldItemType } from '@paalstack/react-ui';
import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import { useRescheduleVisit } from '@/hooks/queries/crm';
import { useProjectSalesExecs, useTeamMembers } from '@/hooks/queries/users';
import { useProjectId } from '@/lib/tenant-context';
import { isAdminLike, useSessionUser } from '@/lib/session';

// Mirrors RescheduleVisitDtoSchema. The date/time are separate native inputs
// (yyyy-MM-dd / HH:mm) combined into one ISO datetime, with the same
// future-datetime refine the server applies so the round-trip cannot 400 on a
// rule the form could have caught.
const rescheduleSchema = z
  .object({
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
    { message: 'The new time must be in the future', path: ['scheduledForDate'] },
  );

type FormValues = z.infer<typeof rescheduleSchema>;

export function RescheduleVisitDialog({
  open,
  onOpenChange,
  visitId,
  leadName,
  currentScheduledFor,
  onRescheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visitId: string;
  /** Shown in the header so the user can confirm WHICH visit they are moving. */
  leadName: string;
  /** The visit's current start, used to pre-fill the inputs. */
  currentScheduledFor: string;
  onRescheduled?: () => void;
}) {
  const { user } = useSessionUser();
  const projectId = useProjectId() ?? undefined;
  const reschedule = useRescheduleVisit();

  // Same exec picker sources as ScheduleVisitDialog, for the same reason: the
  // server rejects a TELECALLER assignee, so a telecaller must be able to name a
  // SALES_EXEC/MANAGER. A manager can legitimately leave it blank ("me").
  const isTelecaller = user?.role === 'TELECALLER';
  const salesExecsQuery = useProjectSalesExecs(projectId);
  const teamMembersQuery = useTeamMembers(isTelecaller ? projectId : undefined);

  const salesExecOptions = useMemo(() => {
    const source = isTelecaller ? teamMembersQuery.data : salesExecsQuery.data;
    const rows = Array.isArray(source) ? source : [];
    return rows
      .map((row) => {
        const r = row as { id?: string; name?: string; email?: string; role?: string };
        if (typeof r.id !== 'string') return null;
        // A telecaller's source is the wider team list; narrow it to the roles
        // the server accepts as an assignee (SALES_EXEC or MANAGER).
        if (isTelecaller && r.role !== 'SALES_EXEC' && r.role !== 'MANAGER') return null;
        return { value: r.id, label: r.name ?? r.email ?? 'User' };
      })
      .filter((o): o is { value: string; label: string } => o !== null);
  }, [isTelecaller, teamMembersQuery.data, salesExecsQuery.data]);

  const showExecPicker = isAdminLike(user?.role) || user?.role === 'MANAGER' || isTelecaller;

  // Pre-fill from the visit's CURRENT time, so the dialog opens on the thing
  // being changed rather than on an unrelated "tomorrow 10am". A reschedule is
  // "same visit, different time", and starting from the real value makes the
  // delta small and obvious.
  const defaults = useMemo(() => {
    const d = new Date(currentScheduledFor);
    if (Number.isNaN(d.getTime())) {
      // Nothing sensible to pre-fill from - fall back to tomorrow 10:00, the
      // same starting point ScheduleVisitDialog uses.
      const fallback = new Date();
      fallback.setDate(fallback.getDate() + 1);
      fallback.setHours(10, 0, 0, 0);
      return {
        date: fallback.toISOString().slice(0, 10),
        time: `${String(fallback.getHours()).padStart(2, '0')}:${String(fallback.getMinutes()).padStart(2, '0')}`,
      };
    }
    return {
      date: d.toISOString().slice(0, 10),
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
  }, [currentScheduledFor]);

  const form = useForm<FormValues>({
    resolver: zodResolver(rescheduleSchema),
    defaultValues: {
      scheduledForDate: defaults.date,
      scheduledForTime: defaults.time,
      salesExecId: '',
      notes: '',
    },
    mode: 'onSubmit',
  });

  // Re-seed on open. `defaultValues` is only read at mount, so without this a
  // dialog opened for a SECOND visit would still show the FIRST visit's time -
  // the identical bug documented in ScheduleVisitDialog's re-seed effect.
  useEffect(() => {
    if (!open) return;
    form.reset({
      scheduledForDate: defaults.date,
      scheduledForTime: defaults.time,
      salesExecId: '',
      notes: '',
    });
  }, [open, defaults.date, defaults.time, form]);

  function onSubmit(values: FormValues) {
    const localDateTime = new Date(`${values.scheduledForDate}T${values.scheduledForTime}:00`);
    const payload: {
      visitId: string;
      scheduledFor: string;
      salesExecId?: string;
      notes?: string;
    } = {
      visitId,
      scheduledFor: localDateTime.toISOString(),
    };
    if (values.salesExecId !== undefined && values.salesExecId.length > 0) {
      payload.salesExecId = values.salesExecId;
    }
    if (values.notes !== undefined && values.notes.trim().length > 0) {
      payload.notes = values.notes.trim();
    }

    reschedule.mutate(payload, {
      onSuccess: () => {
        // The server notifies the project's managers and the org's admins from
        // here, so the confirmation is deliberately about the VISIT, not about
        // who was told - the sender cannot see the recipient list.
        toast.success('Visit rescheduled');
        form.reset();
        onOpenChange(false);
        if (onRescheduled !== undefined) onRescheduled();
      },
      onError: (e) => {
        toast.error(e instanceof Error ? e.message : 'Reschedule failed');
      },
    });
  }

  const fields = [
    {
      type: 'input' as const,
      name: 'scheduledForDate',
      label: 'New date',
      required: true,
      inputType: 'date',
      inputProps: { 'data-qa': 'reschedule-visit-date' },
    },
    {
      type: 'input' as const,
      name: 'scheduledForTime',
      label: 'New time',
      required: true,
      inputType: 'time',
      inputProps: { 'data-qa': 'reschedule-visit-time' },
    },
    ...(showExecPicker
      ? [
          {
            type: 'combobox' as const,
            name: 'salesExecId',
            label: 'Sales exec attending (optional)',
            required: false,
            options: salesExecOptions,
            placeholder: 'Keep the current exec...',
            comboboxProps: {
              emptyOptionMessage: 'No sales exec available - add one to a team on this project',
              'data-qa': 'reschedule-visit-sales-exec',
              selectOptionAsValue: true,
            },
          },
        ]
      : []),
    {
      type: 'textarea' as const,
      name: 'notes',
      label: 'Reason / notes',
      placeholder: 'Customer asked to move to the weekend.',
      textareaProps: { rows: 3, maxLength: 2000 },
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{
        title: 'Reschedule visit',
        description: <span className="text-muted-foreground text-sm">{leadName}</span>,
      }}
      contentClassName="sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="reschedule-visit-form"
            isLoading={reschedule.isPending}
            loadingText="Rescheduling..."
            data-qa="reschedule-visit-submit"
          >
            Reschedule
          </Button>
        </div>
      }
      open={open}
      onOpenChange={onOpenChange}
    >
      <Form
        id="reschedule-visit-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields as FormFieldItemType<FormValues>[]}
      />
    </Dialog>
  );
}
