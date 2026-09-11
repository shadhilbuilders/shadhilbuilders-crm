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
// We use the props-API Form (data-driven `fields` array) per the
// canonical pattern in apps/web/src/app/(app)/leads/new/page.tsx.
import { useMemo } from 'react';

import type { FormFieldItemType } from '@paalstack/react-ui';
import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import { useCreateVisit, useLeads } from '@/hooks/queries/crm';
import { useProjectSalesExecs } from '@/hooks/queries/users';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { labelFor } from '@/lib/labels';

// A lead must be in one of these states to accept a site visit (the server
// enforces this in CreateSiteVisitDto). Only list these so the user can't
// pick a lead that will 400.
const SCHEDULABLE_LEAD_STATES = ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'RESCHEDULED'] as const;

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
};

export function ScheduleVisitDialog({
  open,
  onOpenChange,
  initialLeadId,
  initialDate,
  hideLeadPicker = false,
  onCreated,
}: ScheduleVisitDialogProps) {
  const createVisit = useCreateVisit();
  const { user } = useSessionUser();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : undefined;

  // Only fetch leads that can actually accept a visit (VISIT_REQUESTED,
  // VISIT_SCHEDULED, RESCHEDULED) so the picker never offers a lead that
  // the server will reject.
  const leadsQuery = useLeads({ limit: 100, state: [...SCHEDULABLE_LEAD_STATES] });

  // Sales execs for this project, resolved server-side by role:
  //   - MANAGER: execs in the manager's own team who own leads in this project.
  //   - ADMIN/OWNER: all SALES_EXEC who own leads in this project.
  const isAdminOrOwner = user === null ? false : isAdminLike(user.role);
  const showExecPicker = user !== null && (isAdminOrOwner || user.role === 'MANAGER');
  const projectSalesExecsQuery = useProjectSalesExecs(projectId);
  const salesExecOptions = useMemo(() => {
    if (!showExecPicker) return [];
    const rows = projectSalesExecsQuery.data;
    if (!Array.isArray(rows)) return [];
    return rows.map((u) => ({ value: u.id, label: u.name }));
  }, [showExecPicker, projectSalesExecsQuery.data]);

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
    resolver: zodResolver(scheduleVisitSchema),
    defaultValues: {
      leadId: initialLeadId ?? '',
      scheduledForDate: defaultDate,
      scheduledForTime: defaultTime,
      salesExecId: '',
      notes: '',
    },
    mode: 'onSubmit',
  });

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
        if (onCreated !== undefined) onCreated();
      },
      onError: (e) => {
        toast.error(e instanceof Error ? e.message : 'Schedule failed');
      },
    });
  }

  const fields = [
    ...(hideLeadPicker
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
    },
    {
      type: 'input' as const,
      name: 'scheduledForTime',
      label: 'Time',
      required: true,
      inputType: 'time',
    },
    ...(showExecPicker
      ? [
          {
            type: 'combobox' as const,
            name: 'salesExecId',
            label: 'Sales exec (optional)',
            required: false,
            options: salesExecOptions,
            placeholder: 'Search a sales exec...',
            comboboxProps: {
              emptyOptionMessage: 'No sales execs in this project',
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
      contentClassName='sm:max-w-md'
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
