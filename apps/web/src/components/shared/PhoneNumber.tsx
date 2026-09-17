'use client';

// PhoneNumber - reusable tappable phone display used everywhere a phone
// number is shown (leads table, lead detail, WhatsApp unknown contacts,
// edit dialog). Ported from the Shadhil landing page's CallPhoneDialog
// tel: behavior so the CRM has a single phone-link primitive.
//
// Renders the formatted number as a `tel:` link (opens the native dialer
// on click) with an optional Phone icon. If the number is empty, renders
// the fallback placeholder (default "-") as plain text.

import { cn } from '@paalstack/react-ui/lib';
import { LuPhone } from '@paalstack/react-icons/lu';

import { formatPhone, telUrl } from '@/lib/phone';

interface PhoneNumberProps {
  /** Raw phone string (10-digit Indian or E164). Empty/null renders fallback. */
  phone: string | null | undefined;
  /** Text shown when phone is empty. Defaults to "-". */
  fallback?: string;
  /**
   * Render style:
   * - `link` (default): tappable tel: link in the brand link color.
   * - `text`: plain muted text (non-interactive).
   */
  variant?: 'link' | 'text';
  /** Show a Phone icon before the number. Defaults to false. */
  showIcon?: boolean;
  /** Extra classes for the anchor/text element. */
  className?: string;
  /** Accessible label for the link (screen readers). Defaults to the formatted number. */
  ariaLabel?: string;
  /**
   * T-DASH-MOBILE (2026-09-16): give the number a full-size tap target on a
   * COARSE pointer (touch), where inline text is only ~16px tall.
   *
   * WHY: dialling is THE action for a telecaller, and as inline text the link is
   * ~96x16px - a third of the 44px minimum (WCAG 2.5.8 / HIG) in the one
   * dimension that matters.
   *
   * The NUMBER STAYS VISIBLE. My first version hid it behind `sr-only` on narrow
   * widths and showed an icon instead - which quietly broke a narrow DESKTOP
   * window (fine pointer, <480px wide) down to a bare 14x14 icon with the number
   * gone. Hiding the number was never the goal; a reachable target was. Keeping
   * it also means the telecaller can still read the number.
   */
  largeTapTarget?: boolean;
}

export function PhoneNumber({
  phone,
  fallback = '-',
  variant = 'link',
  showIcon = false,
  className,
  ariaLabel,
  largeTapTarget = false,
}: PhoneNumberProps) {
  const raw = typeof phone === 'string' ? phone.trim() : '';
  if (raw.length === 0) {
    return <span className={cn('text-muted-foreground', className)}>{fallback}</span>;
  }

  const formatted = formatPhone(raw);
  const label = ariaLabel ?? formatted;

  if (variant === 'text') {
    return (
      <span className={cn('text-muted-foreground inline-flex items-center gap-1.5', className)}>
        {showIcon ? <LuPhone className="size-3.5" aria-hidden="true" /> : null}
        {formatted}
      </span>
    );
  }

  return (
    <a
      href={telUrl(raw)}
      className={cn(
        'focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none',
        // TARGET SIZE is a POINTER question, never a width one. Width was my
        // first attempt and it was wrong twice: a landscape phone is 568-844px
        // wide while still a finger device (width-gating handed it the desktop
        // 16px link), and so is a touch tablet. `pointer-fine:` overrides mean
        // the enlargement applies everywhere EXCEPT a fine pointer, which is a
        // stricter and simpler statement than `pointer-coarse:` and covers a
        // laptop with a touchscreen too. A negative margin keeps the enlarged
        // hit area from changing the row's layout box.
        largeTapTarget &&
          'text-link -my-3 min-h-11 min-w-11 justify-center px-2.5 pointer-fine:my-0 pointer-fine:min-h-0 pointer-fine:min-w-0 pointer-fine:px-0',
        className
      )}
      aria-label={label}
    >
      {showIcon ? <LuPhone className="size-3.5" aria-hidden="true" /> : null}
      {formatted}
    </a>
  );
}
