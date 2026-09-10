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
// Form is the props-API Form (data-driven `fields`); numeric fields are
// kept as strings in the form and converted in onSubmit (the codebase
// pattern - avoids the z.coerce type issue).
import { useEffect } from 'react';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';

import { useUpdateUnit } from '@/hooks/queries/inventory';
import { labelFor, INVENTORY_STATUSES, type InventoryStatus } from '@/lib/labels';

const FORM_ID = 'unit-edit-form';

type UnitEditFormValues = {
  unitNumber: string;
  bhk: string;
  facing: string;
  sqft: string;
  price: string;
  status: string;
};

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
};

const STATUS_OPTIONS = INVENTORY_STATUSES.map((value) => ({
  value,
  label: labelFor('inventory', value),
}));

/**
 * The form body, exported for tests (jsdom portal rule: render THIS
 * with renderToStaticMarkup; the Dialog shell + footer are covered by
 * the parent's render flow). Owns only the form markup - the mutation
 * lives in the Dialog shell so the footer can read isPending.
 */
export function UnitEditFormBody({
  unit,
  onSubmit,
}: {
  unit: UnitEditTarget;
  onSubmit: (values: UnitEditFormValues) => void;
}) {
  const form = useForm<UnitEditFormValues>({
    defaultValues: {
      unitNumber: unit.unitNumber,
      bhk: String(unit.bhk),
      facing: unit.facing ?? '',
      sqft: unit.sqft !== null ? String(unit.sqft) : '',
      price: unit.price,
      status: unit.status,
    },
    mode: 'onSubmit',
  });

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
          type: 'input',
          name: 'bhk',
          label: 'BHK',
          required: true,
          inputType: 'number',
          inputProps: {
            min: 1,
            max: 10,
            step: 1,
            'data-qa': 'unit-edit-bhk',
          },
        },
        {
          type: 'input',
          name: 'facing',
          label: 'Facing',
          placeholder: 'North',
          inputProps: {
            maxLength: 40,
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
        {
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
 * holds the currently-editing row in state; null = closed).
 */
export function UnitEditDialog({
  unit,
  open,
  onOpenChange,
  onSaved,
}: UnitEditDialogProps) {
  const updateUnit = useUpdateUnit();
  const pending = updateUnit.isPending;

  const form = useForm<UnitEditFormValues>({
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

  function handleSubmit(values: UnitEditFormValues) {
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
    let sqft: number | null | undefined;
    if (values.sqft !== undefined && values.sqft.trim().length > 0) {
      const parsed = Number(values.sqft);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error('Sqft must be a positive number');
        return;
      }
      sqft = parsed;
    }

    const payload = {
      unitNumber: values.unitNumber.trim(),
      bhk,
      price,
      ...(values.facing && values.facing.trim().length > 0
        ? { facing: values.facing.trim() }
        : { facing: null }),
      ...(sqft !== undefined ? { sqft } : { sqft: null }),
      status: values.status as InventoryStatus,
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
      header={{ title: `Edit unit ${target.unitNumber}`, description: 'Update the unit details.' }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
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
      <UnitEditFormBody unit={unit} onSubmit={handleSubmit} />
    </Dialog>
  );
}
