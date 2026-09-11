'use client';

// /inventory/new - Create-Unit form (DESIGN.md module 4, plan Week 7).
//
// Posts to /api/inventory/units via useCreateUnit (ADMIN/OWNER only -
// the service guard rejects other roles). Server validates with the
// shared CreateUnitDto Zod schema (packages/api-types/src/inventory.ts);
// we re-validate client-side via react-hook-form + zodResolver.
//
// Phase is a data-driven select from useInventoryPhases (the active
// project's phases). Status defaults to AVAILABLE.
//
// We use the props-API Form (data-driven, declarative `fields` array)
// per the canonical pattern in apps/web/src/app/(app)/leads/new/page.tsx.
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import { Button, Form, toast } from '@paalstack/react-ui';

import { useCreateUnit, useInventoryPhases, useProjectOptions } from '@/hooks/queries/inventory';
import { projectHref } from '@/lib/nav';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { labelFor, INVENTORY_STATUSES } from '@/lib/labels';

import { PageHeader } from '@/components/shared/PageHeader';

const createUnitSchema = z.object({
  phaseId: z.string().min(1, 'Pick a phase'),
  unitNumber: z.string().trim().min(1, 'Unit number is required').max(40),
  bhk: z.string().min(1, 'BHK is required'),
  facing: z.string().trim().max(40).optional(),
  sqft: z.string().optional(),
  price: z.string().min(1, 'Price is required'),
  status: z.enum(INVENTORY_STATUSES).optional(),
});

type CreateUnitSchema = z.infer<typeof createUnitSchema>;

const STATUS_OPTIONS = INVENTORY_STATUSES.map((value) => ({
  value,
  label: labelFor('inventory', value),
}));

export default function NewUnitPage() {
  const router = useRouter();
  const createUnit = useCreateUnit();
  // T-ProjectSwitch: resolved project from tenant context; id keys API,
  // slugs key hrefs.
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const phasesQuery = useInventoryPhases(projectId ?? undefined);
  const phases = phasesQuery.data ?? [];

  const optionsQuery = useProjectOptions(projectId ?? undefined);
  const options = optionsQuery.data ?? [];

  const phaseOptions = phases.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const bhkOptions = options
    .filter((o) => o.type === 'BHK')
    .map((o) => ({ value: o.value, label: `${o.value} BHK` }));

  const facingOptions = options
    .filter((o) => o.type === 'FACING')
    .map((o) => ({ value: o.value, label: o.value }));

  const form = useForm<CreateUnitSchema>({
    resolver: zodResolver(createUnitSchema),
    defaultValues: {
      phaseId: '',
      unitNumber: '',
      bhk: '',
      facing: '',
      sqft: '',
      price: '',
      status: 'AVAILABLE',
    },
    mode: 'onSubmit',
  });

  function onSubmit(values: CreateUnitSchema) {
    const bhk = Number(values.bhk);
    if (!Number.isFinite(bhk) || bhk < 1 || bhk > 10) {
      toast.error('BHK must be a whole number between 1 and 10');
      return;
    }
    const price = Number(values.price);
    if (!Number.isFinite(price) || price <= 0) {
      toast.error('Price must be a positive number');
      return;
    }
    let sqft: number | undefined;
    if (values.sqft !== undefined && values.sqft.trim().length > 0) {
      const parsed = Number(values.sqft);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error('Sqft must be a positive number');
        return;
      }
      sqft = parsed;
    }

    const payload = {
      phaseId: values.phaseId,
      unitNumber: values.unitNumber.trim(),
      bhk,
      price,
      ...(values.facing && values.facing.trim().length > 0
        ? { facing: values.facing.trim() }
        : {}),
      ...(sqft !== undefined ? { sqft } : {}),
      ...(values.status !== undefined ? { status: values.status } : {}),
    };

    createUnit.mutate(payload, {
      onSuccess: () => {
        toast.success(`Unit ${payload.unitNumber} created`);
        void router.push(projectHref(orgSlug, projectSlug, '/inventory'));
      },
      onError: (error) => {
        // Server validation messages come through verbatim (400 from
        // the parseBody wrapper in inventory.controller.ts).
        const msg = error instanceof Error ? error.message : 'Create failed';
        toast.error(msg);
      },
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New unit"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Inventory', href: projectHref(orgSlug, projectSlug, '/inventory') },
          { label: 'New' },
        ]}
        subtitle="Add a villa/unit to a phase. Starts AVAILABLE unless set otherwise."
      />

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText={createUnit.isPending ? 'Saving...' : 'Create unit'}
        submitButtonProps={{ disabled: createUnit.isPending }}
        actionClassName="justify-end"
        resetText="Cancel"
        resetButtonProps={{
          onClick: () => {
            form.reset();
            void router.push(projectHref(orgSlug, projectSlug, '/inventory'));
          },
        }}
        fields={[
          {
            type: 'select',
            name: 'phaseId',
            label: 'Phase',
            placeholder: 'Pick a phase',
            required: true,
            description: 'The phase this unit belongs to.',
            options: phaseOptions,
            selectProps: {
              'data-qa': 'unit-phase',
            },
          },
          {
            type: 'input',
            name: 'unitNumber',
            label: 'Unit number',
            placeholder: 'A-101',
            required: true,
            description: 'Unique within the phase (e.g. A-101, B-201).',
            inputProps: {
              maxLength: 40,
              'data-qa': 'unit-number',
            },
          },
          {
            type: 'select',
            name: 'bhk',
            label: 'BHK',
            placeholder: 'Pick a BHK',
            required: true,
            description: 'Bedrooms (1-5).',
            options: bhkOptions,
            selectProps: {
              'data-qa': 'unit-bhk',
            },
          },
          {
            type: 'select',
            name: 'facing',
            label: 'Facing',
            placeholder: 'Pick a facing',
            description: 'Optional. e.g. North, South, East, West.',
            options: facingOptions,
            selectProps: {
              'data-qa': 'unit-facing',
            },
          },
          {
            type: 'input',
            name: 'sqft',
            label: 'Sqft',
            placeholder: '1450',
            inputType: 'number',
            description: 'Optional. Built-up area in square feet.',
            inputProps: {
              min: 1,
              step: 1,
              'data-qa': 'unit-sqft',
            },
          },
          {
            type: 'input',
            name: 'price',
            label: 'Price (₹)',
            placeholder: '5800000',
            required: true,
            inputType: 'number',
            description: 'Unit price in rupees (cap ₹100 Cr).',
            inputProps: {
              min: 1,
              step: 1,
              'data-qa': 'unit-price',
            },
          },
          {
            type: 'select',
            name: 'status',
            label: 'Status',
            placeholder: 'Pick a status',
            description: 'Defaults to Available.',
            options: STATUS_OPTIONS,
            selectProps: {
              'data-qa': 'unit-status',
            },
          },
        ]}
      />

      {/* Manual Cancel shortcut in addition to the form's Reset button. */}
      <div className="flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void router.push(projectHref(orgSlug, projectSlug, '/inventory'))}
        >
          ← Back to Inventory
        </Button>
      </div>
    </div>
  );
}
