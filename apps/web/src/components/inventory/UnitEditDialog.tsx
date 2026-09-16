'use client';

// UnitEditDialog - edit an inventory unit from the grid row actions.
//
// Editable surface (UpdateUnitDto): unitNumber / bhk / facing / sqft /
// price / status. Phase is NOT editable here (a unit's phase is its
// identity anchor; moving it is out of scope for v1).
//
// Two-API convention: props API `<Dialog open onOpenChange header footer>`
// wraps a separately-exported `UnitEditFormBody` - the named export is
// the repo's Dialog/jsdom rule (Base UI portals render empty under
// renderToStaticMarkup, so tests target the body, not the portal).
//
// ONE `useForm` instance per dialog (user-mandated): the Dialog shell owns
// it (it needs form.reset on open + handleSubmit); the body is a pure
// presentational component that receives `form` as a prop and renders the
// `<Form>` fields. Validation is zod (zodResolver). Numeric fields are kept
// as strings in the form and converted in onSubmit (the codebase pattern -
// avoids the z.coerce type issue).
import { useEffect, useMemo } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import { useUpdateUnit, useProjectOptions } from '@/hooks/queries/inventory';
import {
  labelFor,
  INVENTORY_MANUAL_STATUSES,
  isDerivedUnitStatus,
  type InventoryManualStatus,
} from '@/lib/labels';

const FORM_ID = 'unit-edit-form';

const unitEditSchema = z.object({
  unitNumber: z.string().trim().min(1, 'Unit number is required').max(40),
  bhk: z
    .string()
    .min(1, 'BHK is required')
    .refine(
      (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 10;
      },
      { message: 'BHK must be a whole number between 1 and 10' },
    ),
  facing: z.string().optional(),
  sqft: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined || v.trim().length === 0) return true;
        const n = Number(v);
        return Number.isInteger(n) && n > 0;
      },
      { message: 'Sqft must be a positive number' },
    ),
  price: z
    .string()
    .min(1, 'Price is required')
    .refine(
      (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0;
      },
      { message: 'Price must be a positive number' },
    ),
  // Status is a string in the form (the Select holds the raw enum value);
  // the payload casts it to InventoryManualStatus on submit. T-INV-SYNC:
  // only the off-pipeline marks are offered - HOLD/TOKEN are set by bookings,
  // so the server DTO (UpdateUnitStatusSchema) rejects them outright.
  status: z.string(),
});
type UnitEditFormValues = z.infer<typeof unitEditSchema>;

/** Minimal unit shape the dialog needs (from the grid row). */
export type UnitEditTarget = {
  id: string;
  unitNumber: string;
  bhk: number;
  facing: string | null;
  sqft: number | null;
  price: string;
  status: string;
};

export type UnitEditDialogProps = {
  unit: UnitEditTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  projectId: string | null;
};

const STATUS_OPTIONS = INVENTORY_MANUAL_STATUSES.map((value) => ({
  value,
  label: labelFor('inventory', value),
}));

/**
 * The form body, exported for tests (jsdom portal rule: render THIS
 * with renderToStaticMarkup; the Dialog shell + footer are covered by
 * the parent's render flow). Receives the Dialog's single `useForm`
 * instance as a prop - it does NOT create its own (user-mandated: one
 * form per dialog). Owns only the form markup; the mutation lives in
 * the shell.
 */
export function UnitEditFormBody({
  form,
  onSubmit,
  bhkOptions,
  facingOptions,
  derivedStatus,
}: {
  form: UseFormReturn<UnitEditFormValues>;
  onSubmit: (values: UnitEditFormValues) => void;
  bhkOptions: { value: string; label: string }[];
  facingOptions: { value: string; label: string }[];
  /**
   * T-INV-SYNC follow-up: set when the unit's status is owned by its booking
   * (HOLD/TOKEN). The picker is replaced by a read-only row - the status is not
   * an editable value, so offering it in a SELECT whose options cannot contain
   * it (the server DTO allows AVAILABLE|SOLD only) both lied to the operator and
   * made every save fail with a 400.
   */
  derivedStatus?: string | null;
}) {
  return (
    <Form
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      // The Save action lives in the Dialog footer (linked via
      // form={FORM_ID} + type="submit" on the footer button); hide the
      // Form's own action buttons so the submit isn't duplicated.
      hideSubmitButton
      hideResetButton
      fields={[
        {
          type: 'input',
          name: 'unitNumber',
          label: 'Unit number',
          required: true,
          placeholder: 'A-101',
          inputProps: {
            maxLength: 40,
            'data-qa': 'unit-edit-number',
          },
        },
        {
          type: 'select',
          name: 'bhk',
          label: 'BHK',
          required: true,
          options: bhkOptions,
          selectProps: {
            'data-qa': 'unit-edit-bhk',
          },
        },
        {
          type: 'select',
          name: 'facing',
          label: 'Facing',
          placeholder: 'Pick a facing',
          options: facingOptions,
          selectProps: {
            'data-qa': 'unit-edit-facing',
          },
        },
        {
          type: 'input',
          name: 'sqft',
          label: 'Sqft',
          inputType: 'number',
          inputProps: {
            min: 1,
            step: 1,
            'data-qa': 'unit-edit-sqft',
          },
        },
        {
          type: 'input',
          name: 'price',
          label: 'Price (₹)',
          required: true,
          inputType: 'number',
          inputProps: {
            min: 1,
            step: 1,
            'data-qa': 'unit-edit-price',
          },
        },
        // A booking-owned status cannot be chosen, so it is shown read-only
        // instead of as a picker pre-selected with a value it does not offer.
        derivedStatus
          ? {
              type: 'custom',
              name: 'status',
              label: 'Status',
              render: () => (
                <div
                  className='flex flex-col gap-1 rounded-lg border border-input bg-muted/40 px-2.5 py-2'
                  data-qa='unit-edit-status-derived'
                >
                  <span className='text-sm font-medium'>{labelFor('inventory', derivedStatus)}</span>
                  <span className='text-xs text-muted-foreground'>
                    Set by this unit&apos;s booking. Cancel or reject the booking to free the unit.
                  </span>
                </div>
              ),
            }
          : {
              type: 'select',
              name: 'status',
              label: 'Status',
              options: STATUS_OPTIONS,
              selectProps: {
                'data-qa': 'unit-edit-status',
              },
            },
      ]}
    />
  );
}

/**
 * Controlled edit dialog. `unit === null` renders nothing (the grid
 * holds the currently-editing row in state; null = closed). Owns the
 * single `useForm` instance (zod-validated) and the mutation.
 */
export function UnitEditDialog({
  unit,
  open,
  onOpenChange,
  onSaved,
  projectId,
}: UnitEditDialogProps) {
  const updateUnit = useUpdateUnit();
  const pending = updateUnit.isPending;

  // Load the project's option sets for the pickers; merge the current
  // unit's facing/BHK value into the option list so editing a legacy unit
  // never silently drops a value that isn't in the project's defined set.
  const optionsQuery = useProjectOptions(projectId ?? undefined);
  const dbOptions = optionsQuery.data ?? [];

  const bhkOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    const push = (v: string) => {
      if (!seen.has(v)) {
        seen.add(v);
        opts.push({ value: v, label: `${v} BHK` });
      }
    };
    for (const o of dbOptions) if (o.type === 'BHK') push(o.value);
    if (unit !== null) push(String(unit.bhk));
    opts.sort((a, b) => Number(a.value) - Number(b.value));
    return opts;
  }, [dbOptions, unit]);

  const facingOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    const push = (v: string) => {
      if (!seen.has(v)) {
        seen.add(v);
        opts.push({ value: v, label: v });
      }
    };
    for (const o of dbOptions) if (o.type === 'FACING') push(o.value);
    if (unit !== null && unit.facing !== null) push(unit.facing);
    opts.sort((a, b) => a.value.localeCompare(b.value));
    return opts;
  }, [dbOptions, unit]);

  const form = useForm<UnitEditFormValues>({
    resolver: zodResolver(unitEditSchema),
    defaultValues: {
      unitNumber: unit?.unitNumber ?? '',
      bhk: unit ? String(unit.bhk) : '',
      facing: unit?.facing ?? '',
      sqft: unit?.sqft !== null && unit?.sqft !== undefined ? String(unit.sqft) : '',
      price: unit?.price ?? '',
      status: unit?.status ?? 'AVAILABLE',
    },
    mode: 'onSubmit',
  });

  // Reset RHF defaults when a different unit opens - stale values from
  // a previous edit must never leak into the next dialog.
  useEffect(() => {
    if (open && unit !== null) {
      form.reset({
        unitNumber: unit.unitNumber,
        bhk: String(unit.bhk),
        facing: unit.facing ?? '',
        sqft: unit.sqft !== null ? String(unit.sqft) : '',
        price: unit.price,
        status: unit.status,
      });
    }
  }, [open, unit?.id]);

  if (unit === null) return null;
  const target = unit;
  // A booking owns HOLD/TOKEN - the dialog must not offer or submit them.
  const derivedStatus = isDerivedUnitStatus(target.status) ? target.status : null;

  function handleSubmit(values: UnitEditFormValues) {
    const bhk = Number(values.bhk);
    const price = Number(values.price);
    let sqft: number | null | undefined;
    if (values.sqft !== undefined && values.sqft.trim().length > 0) {
      sqft = Number(values.sqft);
    }

    // Status is only submitted for units whose status is NOT booking-owned.
    // Sending a derived status (HOLD/TOKEN) trips the server DTO
    // (UpdateUnitStatusSchema = AVAILABLE|SOLD) with a 400 and the whole save
    // fails - even a pure price edit. Omitting the key leaves Unit.status
    // untouched, so the booking keeps owning it.
    const payload = {
      unitNumber: values.unitNumber.trim(),
      bhk,
      price,
      ...(values.facing && values.facing.trim().length > 0
        ? { facing: values.facing.trim() }
        : { facing: null }),
      ...(sqft !== undefined ? { sqft } : { sqft: null }),
      ...(derivedStatus ? {} : { status: values.status as InventoryManualStatus }),
    };

    updateUnit.mutate(
      { id: target.id, body: payload },
      {
        onSuccess: () => {
          toast.success(`Unit ${payload.unitNumber} updated`);
          onOpenChange(false);
          onSaved?.();
        },
        onError: (error) => {
          const msg = error instanceof Error ? error.message : 'Update failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName='sm:max-w-md'
      header={{ title: `Edit unit ${target.unitNumber}`, description: 'Update the unit details.' }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="unit-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={pending}
            loadingText="Saving..."
            data-qa="unit-edit-save"
          >
            Save changes
          </Button>
        </div>
      }
    >
      <UnitEditFormBody
        form={form}
        onSubmit={handleSubmit}
        bhkOptions={bhkOptions}
        facingOptions={facingOptions}
        derivedStatus={derivedStatus}
      />
    </Dialog>
  );
}
