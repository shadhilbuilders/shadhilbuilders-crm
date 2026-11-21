'use client';

// CopyableLink - show a one-time secret link and make it copyable EVERYWHERE.
//
// This is the feature's primary output (the raw invite token exists only in
// this string, never in the database and never re-fetchable), so the copy path
// has to work on the devices staff invites are actually sent from.
//
// WHY THE FALLBACK IS NOT OPTIONAL. `navigator.clipboard` requires a secure
// context and is ABSENT in several in-app browsers (Instagram / Facebook
// webviews are the realistic case for a link shared over WhatsApp). A Copy
// button that silently does nothing there is the worst possible outcome: the
// admin believes they copied something and sends nothing. So when the API is
// unavailable we (a) hide the Copy button entirely and (b) render the link in
// a readonly input that selects itself on focus, which makes long-press ->
// Select All work the way a phone user expects.
//
// The confirmation is announced, not just shown: on a phone the clipboard
// gives no feedback of its own, and a screen-reader user gets nothing at all
// from a checkmark. `aria-live="polite"` is what makes this a real
// confirmation rather than decoration.
import { Button } from '@paalstack/react-ui';
import { LuCheck, LuCopy } from '@paalstack/react-icons/lu';
import { useEffect, useRef, useState } from 'react';

type Props = {
  /** The absolute URL or opaque text to copy. Never logged. */
  value: string;
  /** Short label above the block. */
  label?: string;
  /** data-qa hooks are suffixed from this so two instances never collide. */
  testId?: string;
};

/**
 * True when the async clipboard API is usable.
 *
 * `navigator.clipboard?.writeText` is a feature test, not a browser sniff: some
 * desktop browsers expose `navigator.clipboard` but not `writeText`, and a
 * jsdom test harness has neither. Starts `false` so SSR and the first client
 * paint agree (no hydration mismatch); the effect corrects it after mount.
 */
function useClipboardAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(
      typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
    );
  }, []);
  return available;
}

export function CopyableLink({ value, label = 'Invite link', testId = 'invite-link' }: Props) {
  const canCopy = useClipboardAvailable();
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the "Copied" flash on unmount so a fast dialog close cannot leave a
  // timer writing state into a dead component.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      // Permission denied or a non-secure context that still exposed the API.
      // Fall through to the input: select the text so the user can copy it by
      // hand instead of being told nothing happened.
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopied(false);
    }
  }

  return (
    <div className="space-y-2" data-qa={`${testId}-block`}>
      <div className="text-muted-foreground text-xs font-medium">{label}</div>

      {/* break-all + font-mono: the token is 43 unbroken base64url characters,
          which otherwise forces a 320px dialog to scroll sideways. Same idiom
          the webhooks/audit pages use for long opaque ids. */}
      <div className="border-border bg-muted/40 rounded-md border p-2">
        <input
          ref={inputRef}
          readOnly
          value={value}
          aria-label={`${label} - select to copy`}
          data-qa={`${testId}-input`}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.currentTarget.select()}
          className="text-foreground w-full bg-transparent font-mono text-xs break-all outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canCopy ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleCopy()}
            leftIcon={copied ? <LuCheck className="size-4" /> : <LuCopy className="size-4" />}
            data-qa={`${testId}-copy-button`}
            // pointer-fine: keeps the 44px finger target from inflating the
            // dialog on a desktop mouse, where 44px is just a chunky button.
            className="min-h-11 pointer-fine:min-h-9"
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        ) : (
          // No clipboard API: the readonly input above IS the affordance.
          // Saying so beats a dead button.
          <p className="text-muted-foreground text-xs">
            Long-press the link above and choose Select All to copy it.
          </p>
        )}

        {/* Announced, so the confirmation exists for a screen-reader user too.
            Rendered always (never conditionally) so the live region exists in
            the tree before its content changes. */}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? 'Invite link copied to clipboard' : ''}
        </span>
      </div>
    </div>
  );
}
