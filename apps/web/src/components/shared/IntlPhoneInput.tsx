'use client';

import * as React from 'react';
import metadata from 'libphonenumber-js/min/metadata';
import flags from 'react-phone-number-input/flags';
import PhoneInput from 'react-phone-number-input/input-core';

import { InputGroup, InputGroupButton, Popover, PopoverModalContent } from '@paalstack/react-ui';
import { cn } from '@paalstack/react-ui/lib';
import {
  DOMESTIC_COUNTRY,
  isCountryCode,
  limitPhoneTyping,
  listCountries,
  maxNationalDigits,
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
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  /** Forwarded to the real input - react-hook-form's `field.onBlur` needs it. */
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  'data-qa'?: string;
  className?: string;
}

/**
 * The flag for a country, from `react-phone-number-input/flags` (which wraps
 * `country-flag-icons`). SVG rather than the emoji pair, because Windows has no
 * flag emoji at all and Android renders some as bare letter pairs - a country
 * picker that shows a different thing per platform is worse than one that shows
 * a flag everywhere.
 *
 * The wrapper fixes the box so the list rows keep a straight left edge: the
 * sources are 3x2 with varying intrinsic sizes.
 */
function CountryFlag({ code, name }: { code: CountryCode; name: string }) {
  const Flag = flags[code];
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-3.5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[2px] outline outline-1 outline-black/10 dark:outline-white/15 [&_svg:not([class*='size-'])]:size-full"
    >
      {Flag ? <Flag title={name} /> : null}
    </span>
  );
}

/**
 * One row per country. `label` stays the plain text the search filters on
 * ("India +91"), `metadata` gives the search a second place to look, and
 * `labelContent` is what the row actually draws - flag, name, dial code.
 */
const COUNTRIES = listCountries().map((country) => ({
  label: `${country.name} ${country.dialCode}`,
  value: country.code,
  dialCode: country.dialCode,
  metadata: { name: country.name, dialCode: country.dialCode },
  labelContent: (
    <span className="flex min-w-0 items-center gap-2">
      <CountryFlag code={country.code} name={country.name} />
      <span className="truncate">{country.name}</span>
      <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
        {country.dialCode}
      </span>
    </span>
  ),
}));

const callingCodeOf = (code: CountryCode): string =>
  COUNTRIES.find((option) => option.value === code)?.dialCode ?? '';

/**
 * What the library is given: canonical E.164 with the `+`.
 *
 * Its own NATIONAL formatting is what the input shows, and for India and the
 * UAE that format carries the trunk prefix (`098765 43210`, `050 123 4567`).
 * The typed path never produces that, so see `stripTrunkPrefix` for the one
 * place it is removed, at display time only.
 */
const toLibraryValue = (digits: string): string => (digits ? `+${digits.replace(/\D/g, '')}` : '');

/**
 * Remove the trunk `0` the library adds when it formats a complete number, so a
 * lead loaded for editing shows `98765 43210` and not `098765 43210`.
 *
 * Only when the shown digits are exactly a `0` in front of the canonical
 * national number: Italy and a few others keep a leading `0` as part of the
 * number itself, and stripping theirs would corrupt the value. Display only -
 * the library still formats and parses everything else.
 */
function stripTrunkPrefix(shown: string, canonicalNational: string): string {
  if (!shown || !canonicalNational) return shown;
  const digits = shown.replace(/\D/g, '');
  if (digits !== `0${canonicalNational}`) return shown;
  const at = shown.indexOf('0');
  return at < 0 ? shown : shown.slice(0, at) + shown.slice(at + 1);
}

export function IntlPhoneInput({
  value,
  onChange,
  defaultCountry = DOMESTIC_COUNTRY,
  id,
  name,
  disabled,
  placeholder,
  className,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  onBlur,
  'data-qa': dataQa,
}: IntlPhoneInputProps) {
  const [country, setCountry] = React.useState<CountryCode>(defaultCountry);
  // The list is CONTROLLED (2026-11-24). It used to be uncontrolled, so picking a
  // country left the sheet open on top of the field the operator had just
  // changed - and on a phone, where the popover is modal, that meant dismissing
  // it by hand before typing. Choosing an option now closes it.
  const [open, setOpen] = React.useState(false);

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
      setOpen(false);
      setCountry(next);
      if (!value) {
        onChange('', next);
        return;
      }
      /**
       * The value crossing this boundary is canonical E.164 DIGITS, so the new
       * country's calling code has to be re-attached. Reporting the bare
       * national digits stored `9876543210`, which the field then parsed as
       * Iran's +98: the trigger jumped to the wrong country and digits
       * disappeared. The national part is also cut to the new country's mobile
       * length, because the field cannot show more digits than the template and
       * a stored number that the display silently drops is worse than a cut.
       */
      const national = nationalDigitsOf(value, next).slice(0, maxNationalDigits(next));
      onChange(`${callingCodeOf(next)}${national}`, next);
    },
    [onChange, value],
  );

  /**
   * A paste that carries its own country (`+1 650 234 5678` while the trigger
   * says India) must not go through the national template: the formatter drops
   * the `+`, the digits are read against India, and the number is stored as
   * 91 650 234 5678. That is the exact corruption this field exists to stop, so
   * the paste is handled here, before the library formats it.
   */
  const handlePasteText = React.useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      if (!text.startsWith('+')) return false;
      const digits = text.replace(/\D/g, '');
      // Too short to carry a country code: the field's normal rules should
      // answer, with the error naming the field.
      if (digits.length < 4) return false;
      const resolved = regionOf(digits);
      if (!resolved) return false;
      setCountry(resolved);
      onChange(digits, resolved);
      return true;
    },
    [onChange],
  );

  const dialCode = callingCodeOf(country);

  // The library renders this component AS the input. A change of its identity
  // therefore unmounts and remounts the field - dropping focus and the caret on
  // every keystroke - so it is created once and reads live props through a ref.
  const live = React.useRef({
    ariaDescribedBy,
    ariaInvalid,
    canonicalValue: value,
    className,
    country,
    dataQa,
    dialCode,
    disabled,
    handleCountry,
    handlePasteText,
    id,
    name,
    onBlur,
    open,
    placeholder,
    setOpen,
  });
  live.current = {
    ariaDescribedBy,
    ariaInvalid,
    canonicalValue: value,
    className,
    country,
    dataQa,
    dialCode,
    disabled,
    handleCountry,
    handlePasteText,
    id,
    name,
    onBlur,
    open,
    placeholder,
    setOpen,
  };

  const shell = React.useCallback(
    // `InputBasic` hands this component the formatted text plus an `onChange`
    // that expects the DOM EVENT, not a string: it reads `event.target.value`
    // itself. Forwarding the raw value threw a TypeError on the first
    // keystroke, so the event is passed straight through and the library stays
    // in charge of what the operator sees.
    (props: { value?: string; onChange?: React.ChangeEventHandler<HTMLInputElement> }) => {
      const s = live.current;

      /**
       * Typing STOPS at the country's mobile length: 10 for India and the US,
       * 9 for the UAE, 8 for Singapore. `limitPhoneTyping` owns that rule,
       * including the `+` exemption for a number that carries its own country.
       *
       * The keystroke itself is refused first (see `handleKeyDown`). Cutting the
       * value alone was not enough: `react-phone-number-input` formats through
       * `input-format`, so handing it one digit too many makes it rewrite the
       * string and drop an already-typed digit - typing 11 digits into the India
       * field left 9 in the box. Refusing the extra key keeps every accepted
       * digit, and the value cut stays as the guard for paste, which arrives in
       * one shot with no keystroke to refuse.
       */
      const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!/^\d$/.test(event.key)) return;
        const el = event.currentTarget;
        // Replacing a selection does not lengthen the number, so it is allowed.
        const replacing = Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0));
        const typed = el.value.trimStart();
        if (typed.startsWith('+')) return;
        const digits = typed.replace(/\D/g, '').length - replacing;
        if (digits >= maxNationalDigits(s.country)) event.preventDefault();
      };

      const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const limited = limitPhoneTyping(event.target.value, s.country);
        if (limited !== event.target.value) event.target.value = limited;
        props.onChange?.(event);
      };

      return (
        <InputGroup
          className={cn(s.disabled && 'opacity-60', s.className)}
          addonStart={
            <Popover
              // `modal` on purpose: on a phone the popover is the whole
              // interaction, and a non-modal layer lets a stray tap on the page
              // behind it close the list while the keyboard is open.
              modal
              open={s.open}
              onOpenChange={s.setOpen}
              trigger={
                <InputGroupButton
                  type="button"
                  disabled={s.disabled}
                  aria-label={`Country calling code: ${countryName(s.country)} (${s.dialCode})`}
                  data-qa={s.dataQa ? `${s.dataQa}-country` : 'intl-phone-country'}
                  className="gap-1.5 px-2"
                >
                  <CountryFlag code={s.country} name={countryName(s.country)} />
                  <span className="tabular-nums">{s.dialCode}</span>
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
                  // 16px, not the component's 14px: iOS Safari zooms the whole
                  // page in when a focused field is under 16px, and it never
                  // zooms back out - the country list would be magnified and
                  // half off-screen on both iPhones.
                  commandInputClassName="h-10 text-base"
                  // 36px rows, not 44px (2026-11-24). The list runs to 245
                  // countries, and the taller row pushed most of it below the
                  // fold on a phone. The row is full width, so the target stays
                  // wide even at this height.
                  commandItemClassName="min-h-9 py-2"
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
            value: stripTrunkPrefix(
              props.value ?? '',
              nationalDigitsOf(s.canonicalValue, s.country),
            ),
            onChange: handleChange,
            onKeyDown: handleKeyDown,
            onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => {
              // Handled before the library formats: see `handlePasteText`.
              if (s.handlePasteText(event.clipboardData.getData('text'))) {
                event.preventDefault();
              }
            },
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
