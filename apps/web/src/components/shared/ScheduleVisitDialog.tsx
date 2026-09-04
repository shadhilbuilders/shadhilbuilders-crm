'use client';

// ScheduleVisitDialog — form for creating a site visit.
//
// Used inside the visits page (Schedule button) and inside the lead
// detail page (when the lead is in VISIT_REQUESTED / VISIT_SCHEDULED).
// Fields match the CreateSiteVisitDto Zod schema in
// packages/api-types/src/visits.ts — the server validates the same
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
import { useForm } from 'react-hook-form';

import { useCreateVisit, useLeads } from '@/hooks/queries/crm';
import { useSessionUser } from '@/lib/session';

type FormValues = {
  leadId: string;
  scheduledForDate: string; // yyyy-MM-dd (HTML date input)
  scheduledForTime: string; // HH:mm (HTML time input)
  salesExecId: string;
  notes: string;
};

type ScheduleVisitDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Pre-select a lead (e.g. from the lead detail page). */
  initialLeadId?: string;
  /** Hide the lead picker when a lead is pre-selected. */
  hideLeadPicker?: boolean;
  /** Called after a successful create with the new visit row. */
  onCreated?: () => void;
};

export function ScheduleVisitDialog({
  open,
  onOpenChange,
  initialLeadId,
  hideLeadPicker = false,
  onCreated,
}: ScheduleVisitDialogProps) {
  const createVisit = useCreateVisit();
  const { user } = useSessionUser();
  const leadsQuery = useLeads({ limit: 100 });

  // Default to tomorrow at 10am — gives the user a sensible starting
  // point while still requiring them to confirm the date.
  const defaultDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }, []);

  const form = useForm<FormValues>({
    defaultValues: {
      leadId: initialLeadId ?? '',
      scheduledForDate: defaultDate,
      scheduledForTime: '10:00',
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
      return {
        value: row.id,
        label: `${row.name ?? 'Lead'}${typeof row.status === 'string' ? ` (${row.status})` : ''}`,
      };
    });
  }, [leadsQuery.data]);

  function onSubmit(values: FormValues) {
    if (values.leadId.length === 0) {
      toast.error('Pick a lead');
      return;
    }

    // Combine date + time into an ISO datetime with the user's local
    // timezone offset. The server's Zod refine checks "in the future"
    // against the absolute time, so local-now > future-now is fine.
    const localDateTime = new Date(
      `${values.scheduledForDate}T${values.scheduledForTime}:00`,
    );
    if (localDateTime.getTime() <= Date.now()) {
      toast.error('scheduledFor must be in the future');
      return;
    }

    const payload: {
      leadId: string;
      scheduledFor: string;
      salesExecId?: string;
      notes?: string;
    } = {
      leadId: values.leadId,
      scheduledFor: localDateTime.toISOString(),
    };
    if (values.salesExecId.length > 0) {
      payload.salesExecId = values.salesExecId;
    }
    if (values.notes.trim().length > 0) {
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
            type: 'select' as const,
            name: 'leadId',
            label: 'Lead',
            required: true,
            options: leadOptions,
            placeholder: 'Pick a lead',
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
    ...(user?.role === 'ADMIN' || user?.role === 'MANAGER'
      ? [
          {
            type: 'input' as const,
            name: 'salesExecId',
            label: 'Sales exec (cuid, optional)',
            placeholder: 'Leave blank to assign yourself',
            description: 'Optional. Paste a user id to assign another exec.',
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
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={createVisit.isPending}
            form="schedule-visit-form"
          >
            {createVisit.isPending ? 'Scheduling…' : 'Schedule'}
          </Button>
        </div>
      }
      open={open}
      onOpenChange={onOpenChange}
    >
      <Form
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        fields={fields as FormFieldItemType<FormValues>[]}
      />
    </Dialog>
  );
}
