'use client';

// /bookings/new - Create-Booking form (T-F4).
//
// Posts to /api/bookings via useCreateBooking (T-F1). Server
// validates with CreateBookingDto Zod schema in
// packages/api-types/src/bookings.ts; we mirror the validation
// client-side so 400s land as inline errors via the standard form
// flow.
//
// On success the form redirects to the BOOKINGS LIST (not the parent lead's
// page). The operator has just created a booking and wants to see it in
// context; the lead page shows no trace of it. Pinned by page.test.tsx.
//
// Lead picker is data-driven via useLeads (the same pattern as
// ScheduleVisitDialog). Unit picker is data-driven via useInventoryUnits
// (AVAILABLE units in the active project) - the inventory module is live
// (2026-09-10). A `?unitId=` query param pre-fills the picker (deep-link
// from the inventory detail sheet).
//
// We use the props-API Form (data-driven `fields` array) per
// the canonical pattern in apps/web/src/app/(app)/leads/new/page.tsx.
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Suspense, useEffect, useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import { Button, Form, toast } from '@paalstack/react-ui';

import { useCreateBooking, useLeads } from '@/hooks/queries/crm';
import { useInventoryUnits } from '@/hooks/queries/inventory';
import { labelFor } from '@/lib/labels';
import { afterBookingCreateHref } from '@/lib/bookings';
import { projectHref } from '@/lib/nav';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';
import { LuArrowLeft } from '@paalstack/react-icons/lu';

import { currencyIntl } from '@/lib/format';

// Client-side mirror of CreateBookingDto (packages/api-types/src/bookings.ts).
// Numeric fields are kept as strings in the form and coerced on submit
// (the codebase pattern - avoids the z.coerce type issue). The server
// re-validates with the canonical DTO.
const createBookingSchema = z.object({
  leadId: z.string().min(1, 'Pick a lead'),
  unitId: z.string().min(1, 'Pick a unit'),
  amount: z
    .string()
    .min(1, 'Amount is required')
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, {
      message: 'Amount must be a positive number',
    })
    .refine((v) => Number(v) <= 1_000_000_000, {
      message: 'Amount too large (cap ₹100 Cr)',
    }),
  tokenAmount: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === '' || (Number.isFinite(Number(v)) && Number(v) > 0),
      { message: 'Token amount must be a positive number' },
    ),
  notes: z.string().max(2000, 'Notes must be less than 2000 characters').trim().optional(),
});

type CreateBookingSchema = z.infer<typeof createBookingSchema>;

export default function NewBookingPage() {
  // useSearchParams() must be inside a Suspense boundary (Next.js App
  // Router requirement - same pattern as the leads page) or the client
  // render throws a hydration mismatch. The fallback is a shape-matched
  // form skeleton so the page never flashes blank while the search
  // params resolve.
  return (
    <Suspense fallback={<Skeleton variant="text" count={6} />}>
      <NewBookingPageInner />
    </Suspense>
  );
}

function NewBookingPageInner() {
  const router = useRouter();
  const createBooking = useCreateBooking();
  // T-ProjectSwitch: resolved project from tenant context; id keys API,
  // slugs key hrefs.
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const leadsQuery = useLeads({
    limit: 200,
    projectId: projectId ?? undefined,
    // A booking is initiated from a lead in NEGOTIATION (matches the
    // empty-state copy). Filter server-side so the picker only offers
    // bookable leads.
    state: ['NEGOTIATION'],
  });
  // Inventory picker: AVAILABLE units in the active project.
  const unitsQuery = useInventoryUnits({
    projectId: projectId ?? undefined,
    status: ['AVAILABLE'],
    limit: 200,
  });
  const searchParams = useSearchParams();
  const unitParam = searchParams.get('unitId') ?? '';

  const form = useForm<CreateBookingSchema>({
    resolver: zodResolver(createBookingSchema),
    defaultValues: {
      leadId: '',
      unitId: unitParam,
      amount: '',
      tokenAmount: '',
      notes: '',
    },
    mode: 'onSubmit',
  });

  const leadOptions = (() => {
    const rows = leadsQuery.data;
    if (rows === undefined || !Array.isArray(rows)) return [];
    return (rows as Array<{ id: string; name?: string; status?: string }>).map(
      (row) => ({
        value: row.id,
        label: `${row.name ?? 'Lead'}${
          typeof row.status === 'string' && row.status.length > 0
            ? ` (${labelFor('lead', row.status)})`
            : ''
        }`,
      }),
    );
  })();

  // T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16, owner ruling): the booking total IS
  // the unit's price. It used to be a free-typed number, and in practice NONE of
  // the 11 existing bookings matched their unit - amounts like ₹1 and ₹1212
  // against ₹43,50,000 units. The amount is now DERIVED and read-only.
  //
  // Prices are kept alongside the options (and shown in the label) so the user
  // can see which figure is being applied without opening the inventory page.
  // `price` arrives as a STRING because Prisma serialises Decimal that way, so it
  // is parsed once here and rendered through the shared currency formatter.
  const unitRows = useMemo(() => {
    const rows = unitsQuery.data;
    if (rows === undefined || !Array.isArray(rows)) return [];
    return rows as Array<{ id: string; unitNumber?: string; bhk?: number; price?: string }>;
  }, [unitsQuery.data]);

  const unitOptions = useMemo(
    () =>
      unitRows.map((row) => {
        const price = typeof row.price === 'string' ? Number(row.price) : NaN;
        const priceLabel = Number.isFinite(price) ? ` · ${currencyIntl.format(price)}` : '';
        return {
          value: row.id,
          label: `${row.unitNumber ?? 'Unit'}${
            typeof row.bhk === 'number' ? ` · ${row.bhk} BHK` : ''
          }${priceLabel}`,
        };
      }),
    [unitRows],
  );

  // Price of the currently-selected unit, or null when nothing is chosen yet.
  //
  // `form.watch` is called at the TOP LEVEL (not inside useMemo) because watch is
  // what SUBSCRIBES this component to the field. Calling it inside a useMemo would
  // read the value on first render but never re-run when the unit changes - the
  // amount would silently keep the first unit's price. Same for the picker's own
  // label. The derived value itself is a cheap lookup, so it is not memoised.
  const selectedUnitId = form.watch('unitId');
  const selectedUnitPrice = (() => {
    if (typeof selectedUnitId !== 'string' || selectedUnitId.length === 0) return null;
    const row = unitRows.find((u) => u.id === selectedUnitId);
    if (row === undefined || typeof row.price !== 'string') return null;
    const value = Number(row.price);
    return Number.isFinite(value) ? value : null;
  })();

  // Keep the form's `amount` in lockstep with the selection. A watcher rather
  // than an onChange on the picker: `reset()` and the `?unitId=` deep-link both
  // set the unit WITHOUT going through a click, and both must fill the amount.
  // Without this the field could sit empty (or stale) while the server would
  // reject the submit.
  useEffect(() => {
    form.setValue('amount', selectedUnitPrice === null ? '' : String(selectedUnitPrice), {
      shouldValidate: false,
    });
  }, [selectedUnitPrice, form]);

  function onSubmit(values: CreateBookingSchema) {
    // zodResolver already validated leadId/unitId/amount/tokenAmount.
    const amount = Number(values.amount);
    let tokenAmount: number | undefined;
    if (values.tokenAmount !== undefined && values.tokenAmount.trim().length > 0) {
      tokenAmount = Number(values.tokenAmount);
    }

    const payload: {
      leadId: string;
      unitId: string;
      amount: number;
      tokenAmount?: number;
      notes?: string;
    } = {
      leadId: values.leadId,
      unitId: values.unitId,
      amount,
    };
    if (tokenAmount !== undefined) payload.tokenAmount = tokenAmount;
    if (values.notes !== undefined && values.notes.trim().length > 0) {
      payload.notes = values.notes.trim();
    }

    createBooking.mutate(payload, {
      onSuccess: () => {
        toast.success('Booking created in HOLD');
        // Land on the bookings list - see afterBookingCreateHref() for why the
        // parent lead's page is the wrong destination here.
        void router.push(afterBookingCreateHref(orgSlug, projectSlug));
      },
      onError: (error) => {
        const msg = error instanceof Error ? error.message : 'Create failed';
        toast.error(msg);
      },
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New booking"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Bookings', href: projectHref(orgSlug, projectSlug, '/bookings') },
          { label: 'New' },
        ]}
        subtitle="Starts in HOLD. Manager approval advances to APPROVED."
      />

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText={createBooking.isPending ? 'Saving...' : 'Create booking'}
        submitButtonProps={{ disabled: createBooking.isPending }}
        actionClassName='justify-end'
        resetText="Cancel"
        onReset={() => {
          form.reset();
          void router.push(projectHref(orgSlug, projectSlug, '/bookings'));
        }}
        fields={[
          {
            type: 'combobox',
            name: 'leadId',
            label: 'Lead',
            required: true,
            options: leadOptions,
            placeholder: 'Search a lead...',
            comboboxProps: {
              emptyOptionMessage: 'No bookable leads found',
              selectOptionAsValue: true,
              'data-qa': 'booking-lead-id',
            },
          },
          {
            type: 'combobox',
            name: 'unitId',
            label: 'Unit',
            required: true,
            options: unitOptions,
            placeholder: 'Search an available unit...',
            description:
              'Available units in this project. A booking holds the unit.',
            comboboxProps: {
              emptyOptionMessage: 'No available units in this project',
              selectOptionAsValue: true,
              'data-qa': 'booking-unit-id',
            },
          },
          {
            // T-BOOKING-AMOUNT-FROM-UNIT: DERIVED, not entered.
            //
            // The value comes from the selected unit's price (see
            // `selectedUnitPrice`), so this field is read-only. `readOnly` rather
            // than `disabled` on purpose: a disabled input is not focusable and
            // screen readers skip it, so a keyboard user would never discover the
            // amount at all. Read-only keeps it in the tab order, announced, and
            // selectable/copyable - it just cannot be edited.
            //
            // Still `required` + validated: the schema runs on submit, so an
            // unselected unit (empty amount) fails loudly instead of posting 0.
            type: 'input',
            name: 'amount',
            label: 'Total amount (₹)',
            required: true,
            inputType: 'number',
            description:
              selectedUnitPrice === null
                ? 'Set automatically from the unit you pick.'
                : `From ${(unitRows.find((u) => u.id === selectedUnitId)?.unitNumber) ?? 'the selected unit'} - set by the unit price, not editable here.`,
            placeholder: 'Pick a unit...',
            // Read-only fields still LOOK editable unless styled - a muted
            // background is the standard "you cannot type here" signal.
            // `className` is a FIELD-level prop: `inputProps` is typed as
            // Omit<InputProps, 'label'|'className'|...>, so passing it there is a
            // compile error (the Form owns the input's layout classes).
            className: 'bg-muted/50 cursor-not-allowed',
            inputProps: {
              min: 1,
              step: 1,
              readOnly: true,
              'data-qa': 'booking-amount',
            },
          },
          {
            type: 'input',
            name: 'tokenAmount',
            label: 'Token amount (₹, optional)',
            inputType: 'number',
            description: 'Optional. Booking starts in HOLD if zero / blank.',
            placeholder: 'Enter token amount here...',
            inputProps: {
              min: 0,
              step: 1,
              'data-qa': 'booking-token-amount',
            },
          },
          {
            type: 'textarea',
            name: 'notes',
            label: 'Notes',
            description: 'Optional. Max 2000 characters.',
            placeholder: 'Enter notes here...',
            textareaProps: { rows: 3, maxLength: 2000 },
          },
        ]}
      />

      <div className="flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void router.push(projectHref(orgSlug, projectSlug, '/bookings'))}
          leftIcon={<LuArrowLeft className="size-4" aria-hidden />}
        >
          Back to bookings
        </Button>
      </div>
    </div>
  );
}