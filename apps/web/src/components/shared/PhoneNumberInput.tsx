'use client';

// PhoneNumberInput - reusable phone field for the props-API Form.
//
// The Form is data-driven (`fields: FormFieldItemType[]`); the canonical
// way to inject custom input behavior is `type: 'custom'` with
// `render: ({ field }) => <PhoneNumberInput {...field} ... />` (same
// pattern as PasswordInput in users/page.tsx / change-password/page.tsx).
//
// This field:
//   - renders as `type="tel"` with `inputMode="numeric"`
//   - asks for a 10-DIGIT number: sanitizes input to digits-only and caps
//     at 10 chars by default. The user does NOT type the `+91` prefix - it
//     is prepended at the persistence layer (PhoneSchema normalizes a bare
//     10-digit Indian mobile to E.164 `91XXXXXXXXXX` before it's stored).
//   - lets a caller pass an optional `max` (default 10) and label/QA hooks
//   - does NOT normalize E.164 itself - the Form's zod schema
//     (`PhoneSchema`) prepends `91` at submit, this field just guards the
//     wire value while typing
//
// Usage (inside a `fields` array):
//   {
//     type: 'custom',
//     name: 'phone',
//     label: 'Phone',
//     required: true,
//     render: ({ field }) => (
//       <PhoneNumberInput
//         {...field}
//         placeholder="9876543210"
//         data-qa="lead-phone"
//       />
//     ),
//   }
import type { ComponentPropsWithoutRef } from 'react';

import { Input } from '@paalstack/react-ui';

/** Strip non-digits and cap at `max` chars (landing lead-form helper). */
export function digitsOnly(value: string, max: number): string {
  return value.replace(/\D/g, '').slice(0, max);
}

type PhoneNumberInputProps = Omit<
  ComponentPropsWithoutRef<'input'>,
  'type' | 'onChange' | 'value' | 'children'
> & {
  /** Max digit length (default 10 - user types a 10-digit mobile, no +91). */
  max?: number;
  /** data-qa for the input. */
  'data-qa'?: string;
} & {
  // RHF ControllerRenderProps injects these; keep them typed loosely so
  // spreading `{...field}` works without importing react-hook-form types.
  value?: string;
  onChange?: (value: string) => void;
};

export function PhoneNumberInput({
  className,
  'data-qa': dataQa,
  max = 10,
  value,
  onChange,
  ...inputProps
}: PhoneNumberInputProps) {
  return (
    <Input
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      className={className}
      data-qa={dataQa}
      maxLength={max}
      value={value || ''}
      onChange={(event) => onChange?.(digitsOnly(event.currentTarget.value, max))}
      {...inputProps}
    />
  );
}
