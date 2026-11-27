// IntlPhoneInput - the parts of the field that cannot be exercised in jsdom.
//
// `react-phone-number-input` formats through `input-format` against a real DOM
// input, so a rendered-markup test can assert what the field SHOWS but not what
// happens under a keystroke. The display half is asserted here on the server
// render; the input half is asserted against the source, the same way the repo
// tests `env(safe-area-inset-*)` contracts that jsdom cannot observe.
//
// The behaviour these guard, all found by driving the field in a browser on
// 2026-11-23:
//   1. Typing one digit past the country's mobile length used to DELETE a digit
//      already typed (11 keys into India left 9). The keystroke is now refused.
//   2. Pasting `+1 650 234 5678` while India was selected stored 91 650 234
//      5678. The paste is now intercepted before the national template.
//   3. A stored number rendered with libphonenumber's trunk `0` (`098765
//      43210`), so a prefilled lead showed a digit the record does not hold.
import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IntlPhoneInput } from './IntlPhoneInput';

const noop = () => undefined;

/** The rendered `value` of the phone input. */
function shown(html: string): string {
  const input = /<input[^>]*data-qa="phone"[^>]*>/.exec(html)?.[0] ?? '';
  return /value="([^"]*)"/.exec(input)?.[1] ?? '';
}

function render(value: string, defaultCountry: 'IN' | 'AE' | 'US' | 'IT') {
  return renderToStaticMarkup(
    <IntlPhoneInput
      data-qa="phone"
      value={value}
      onChange={noop}
      defaultCountry={defaultCountry}
    />,
  );
}

const source = readFileSync('src/components/shared/IntlPhoneInput.tsx', 'utf8');

describe('IntlPhoneInput display', () => {
  it('shows a stored Indian mobile without the trunk zero', () => {
    // libphonenumber's NATIONAL format would print `098765 43210`.
    expect(shown(render('919876543210', 'IN'))).toBe('98765 43210');
  });

  it('shows a stored UAE mobile without the trunk zero', () => {
    expect(shown(render('971501234567', 'AE'))).toBe('50 123 4567');
  });

  it('leaves a number whose national format has no trunk prefix alone', () => {
    expect(shown(render('16502345678', 'US'))).toBe('(650) 234-5678');
  });

  it('never strips a leading zero that is part of the number', () => {
    // Italy keeps the 0 in the national significant number: `02 1234 5678`
    // parsed back is still 0212345678, so there is nothing to remove.
    const before = shown(render('390212345678', 'IT'));
    expect(before.replace(/\D/g, '').startsWith('0')).toBe(true);
  });
});

describe('IntlPhoneInput input handling', () => {
  it('refuses the keystroke that would pass the country length', () => {
    // The value cut alone rewound the field; the keydown guard is what keeps
    // every accepted digit.
    expect(source).toContain('onKeyDown: handleKeyDown');
    expect(source).toContain('if (digits >= maxNationalDigits(s.country)) event.preventDefault();');
  });

  it('intercepts a paste that carries its own country code', () => {
    expect(source).toContain('onPaste:');
    expect(source).toContain("if (s.handlePasteText(event.clipboardData.getData('text')))");
    // The canonical value is re-stamped with the pasted number's country, not
    // the country that happened to be on the trigger.
    expect(source).toContain('onChange(digits, resolved);');
  });
});

describe('IntlPhoneInput country picker', () => {
  it('shows the country flag and the dial code on the trigger', () => {
    // Two things sit on the trigger: the flag (so the list and the button read
    // as the same country at a glance) and the dial code (the only part that
    // says what will be STORED). Neither replaces the other.
    const html = render('', 'US');
    const trigger =
      /<button[^>]*data-qa="phone-country"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    expect(trigger, 'the country trigger is not rendered').not.toBe('');
    expect(trigger, 'the trigger carries no flag').toContain('<svg');
    expect(trigger, 'the trigger does not show the dial code').toContain('+1');
  });

  it('draws an SVG flag per row, never an emoji pair', () => {
    // Windows has no flag emoji and Android renders some as two letters, so a
    // country list built from emoji looks different on every machine. The icons
    // come from `react-phone-number-input/flags`, which is a real direct
    // dependency - pnpm's strict layout will not resolve a transitive one.
    expect(source).toContain("import flags from 'react-phone-number-input/flags';");
    expect(source).toContain('const Flag = flags[code];');
    expect(source).toMatch(/labelContent: \(/);
  });

  it('keeps the list usable on a phone: 14px search, 36px rows', () => {
    // 36px keeps a usable number of the 245 countries on screen at once.
    // Both are props of the shared picker, not CSS we own. The search input is
    // `text-sm` like every other input in the app - never `text-base`.
    expect(source).toContain('commandInputClassName="h-10 text-sm"');
    expect(source).toContain('commandItemClassName="min-h-9 py-2"');
  });

  it('closes the list as soon as a country is picked', () => {
    // Left uncontrolled, the sheet stayed open over the field the operator had
    // just changed. On a phone the popover is modal, so that meant dismissing it
    // by hand before typing the number.
    expect(source).toContain('open={s.open}');
    expect(source).toContain('onOpenChange={s.setOpen}');
    // ... and the pick itself is what closes it, before the change goes out.
    expect(source).toMatch(/if \(!isCountryCode\(next\)\) return;\s*setOpen\(false\);/);
  });
});

vi.clearAllMocks();
