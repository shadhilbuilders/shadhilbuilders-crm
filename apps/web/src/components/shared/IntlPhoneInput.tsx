'use client';

import * as React from 'react';
import metadata from 'libphonenumber-js/min/metadata';
import PhoneInput from 'react-phone-number-input/input-core';

import { InputGroup, InputGroupButton, Popover, PopoverModalContent } from '@paalstack/react-ui';
import { cn } from '@paalstack/react-ui/lib';
import {
  DOMESTIC_COUNTRY,
  isCountryCode,
  listCountries,
  nationalDigitsOf,
  regionOf,
  type CountryCode,
} from '@shadhil/api-types/phone';

/**
 * International phone field.
 *
 * Behaviour (as-you-type formatting, caret handling, the country's digit
 * rules) comes from `react-phone-number-input/input-core`, which takes our
 * input element and the `min` metadata. Its own country select is not used:
 * this field is one input with a country button inside it, so the shell is the
 * library's `InputGroup` and the list is `PopoverModalContent`.
 *
 * The value crossing this boundary is what gets STORED: canonical digits with
 * no `+`, exactly what `Lead.phoneE164` holds. The `+` is added only for the
 * library call.
 */

export type IntlPhoneSize = 'sm' | 'md' | 'lg';

export interface IntlPhoneInputProps {
  /** Canonical E.164 digits, no `+`. Empty string for "no number". */
  value: string;
  /** Called with canonical digits and the resolved country. */
  onChange: (value: string, country: CountryCode | null) => void;
  /**
   * The country the trigger starts on. Always visible, so a default is not a
   * silent one: the operator can see which country will be stored.
   */
  defaultCountry?: CountryCode;
  id?: string;
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  size?: IntlPhoneSize;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  /** Forwarded to the real input - react-hook-form's `field.onBlur` needs it. */
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  'data-qa'?: string;
  className?: string;
}

const COUNTRIES = listCountries().map((country) => ({
  label: `${country.name} ${country.dialCode}`,
  value: country.code,
}));

const HEIGHTS: Record<IntlPhoneSize, string> = {
  sm: 'h-9',
  md: 'h-10',
  lg: 'min-h-11',
};

const toLibraryValue = (digits: string): string => (digits ? `+${digits.replace(/\D/g, '')}` : '');

export function IntlPhoneInput({
  value,
  onChange,
  defaultCountry = DOMESTIC_COUNTRY,
  id,
  name,
  disabled,
  placeholder,
  size = 'md',
  className,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  onBlur,
  'data-qa': dataQa,
}: IntlPhoneInputProps) {
  const [country, setCountry] = React.useState<CountryCode>(defaultCountry);

  // The stored value is the source of truth. When it changes from outside
  // (prefill, a server refresh) the trigger follows the number, so the field
  // never shows +91 beside a US number.
  React.useEffect(() => {
    const parsed = regionOf(value);
    if (parsed) setCountry(parsed);
  }, [value]);

  const handleValue = React.useCallback(
    (next: string | undefined) => {
      const digits = (next ?? '').replace(/\D/g, '');
      const resolved = regionOf(digits);
      if (resolved) setCountry(resolved);
      onChange(digits, resolved);
    },
    [onChange],
  );

  const handleCountry = React.useCallback(
    (next: string) => {
      if (!isCountryCode(next)) return;
      setCountry(next);
      // Changing the country keeps the digits and re-reports with the new
      // country; it never clears the field or rewrites the subscriber part.
      onChange(nationalDigitsOf(value, next), next);
    },
    [onChange, value],
  );

  const dialCode = COUNTRIES.find((option) => option.value === country)?.label.split(' ').pop() ?? '';

  // The library renders this component AS the input. A change of its identity
  // therefore unmounts and remounts the field - dropping focus and the caret on
  // every keystroke - so it is created once and reads live props through a ref.
  const live = React.useRef({
    ariaDescribedBy,
    ariaInvalid,
    className,
    country,
    dataQa,
    dialCode,
    disabled,
    handleCountry,
    id,
    name,
    onBlur,
    placeholder,
    size,
  });
  live.current = {
    ariaDescribedBy,
    ariaInvalid,
    className,
    country,
    dataQa,
    dialCode,
    disabled,
    handleCountry,
    id,
    name,
    onBlur,
    placeholder,
    size,
  };

  const shell = React.useCallback(
    // `InputBasic` hands this component the formatted text plus an `onChange`
    // that expects the DOM EVENT, not a string: it reads `event.target.value`
    // itself. Forwarding the raw value threw a TypeError on the first
    // keystroke, so the event is passed straight through and the library stays
    // in charge of what the operator sees.
    (props: { value?: string; onChange?: React.ChangeEventHandler<HTMLInputElement> }) => {
      const s = live.current;
      return (
        <InputGroup
          className={cn(HEIGHTS[s.size], s.disabled && 'opacity-60', s.className)}
          addonStart={
            <Popover
              trigger={
                <InputGroupButton
                  type="button"
                  disabled={s.disabled}
                  aria-label={`Country calling code: ${countryName(s.country)} (${s.dialCode})`}
                  data-qa={s.dataQa ? `${s.dataQa}-country` : 'intl-phone-country'}
                >
                  {s.dialCode}
                </InputGroupButton>
              }
              contentClassName="w-[min(20rem,calc(100vw-2rem))] p-0"
              content={
                <PopoverModalContent
                  options={COUNTRIES}
                  value={s.country}
                  onValueChange={s.handleCountry}
                  filterBy="all"
                  searchPlaceholder="Search country or code"
                  emptyOptionMessage="No country matches that"
                />
              }
            />
          }
          inputProps={{
            id: s.id,
            name: s.name,
            type: 'tel',
            inputMode: 'tel',
            disabled: s.disabled,
            placeholder: s.placeholder,
            value: props.value ?? '',
            onChange: props.onChange,
            onBlur: s.onBlur,
            'aria-invalid': s.ariaInvalid,
            'aria-describedby': s.ariaDescribedBy,
            'data-qa': s.dataQa,
            autoComplete: 'tel',
          }}
        />
      );
    },
    [],
  );

  return (
    <PhoneInput
      inputComponent={shell}
      metadata={metadata}
      country={country}
      defaultCountry={country}
      value={toLibraryValue(value) || undefined}
      onChange={handleValue}
      international={false}
      // InputBasic, not InputSmart: the smart caret implementation drives a
      // raw `<input>` through `input-format` and needs a real DOM ref, which a
      // custom `inputComponent` (our InputGroup) does not hand it. InputBasic
      // formats the same way and works with any component.
      smartCaret={false}
    />
  );
}

function countryName(code: CountryCode): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
