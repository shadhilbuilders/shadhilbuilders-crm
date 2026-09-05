'use client';

// PasswordInput — password field with a show/hide visibility toggle.
//
// Shared by every password surface (login, change-password, users):
// one implementation, one QA contract. Uses the library's prop-API
// InputGroup with a ghost InputGroupButton as addonEnd — the button
// form (not a bare icon) because WCAG 2.5.8 wants a real control:
// min 44px hit target, aria-pressed state, and a focusable tab stop.
//
// The addon wrapper's own click handler refocuses the INPUT when the
// click didn't land on a button (dist source: `if
// (e.target.closest('button')) return`), so a mis-aimed click never
// closes the keyboard on mobile — another reason the button variant
// is the right primitive here.
//
// a11y contract: the toggle carries aria-label ("Show password" /
// "Hide password") + aria-pressed; the input gets aria-keyshortcuts
// unchanged. Type flips password <-> text only.
import { useState, type ComponentPropsWithoutRef } from 'react';

import { InputGroup, InputGroupButton } from '@paalstack/react-ui';
import { LuEye, LuEyeOff } from '@paalstack/react-icons/lu';

type PasswordInputProps = Omit<
  ComponentPropsWithoutRef<'input'>,
  'type' | 'children'
> & {
  /** data-qa for the input itself (the toggle gets `${id}-visibility`). */
  'data-qa'?: string;
};

export function PasswordInput({
  className,
  'data-qa': dataQa,
  ...inputProps
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <InputGroup
      inputProps={{
        type: visible ? 'text' : 'password',
        className,
        'data-qa': dataQa,
        autoComplete: inputProps.autoComplete,
        ...inputProps,
      }}
      addonEnd={
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          data-qa={dataQa ? `${dataQa}-visibility` : 'password-visibility-toggle'}
        >
          {visible ? (
            <LuEyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <LuEye className="h-4 w-4" aria-hidden="true" />
          )}
        </InputGroupButton>
      }
    />
  );
}