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
   *  - `link` (default): tappable tel: link in the brand link color.
   *  - `text`: plain muted text (non-interactive).
   */
  variant?: 'link' | 'text';
  /** Show a Phone icon before the number. Defaults to false. */
  showIcon?: boolean;
  /** Extra classes for the anchor/text element. */
  className?: string;
  /** Accessible label for the link (screen readers). Defaults to the formatted number. */
  ariaLabel?: string;
}

export function PhoneNumber({
  phone,
  fallback = '-',
  variant = 'link',
  showIcon = false,
  className,
  ariaLabel,
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
        {showIcon ? <LuPhone className="size-3.5" /> : null}
        {formatted}
      </span>
    );
  }

  return (
    <a
      href={telUrl(raw)}
      className={cn(
        'inline-flex items-center gap-1.5 underline-offset-4 hover:underline',
        className,
      )}
      aria-label={label}
    >
      {showIcon ? <LuPhone className="size-3.5" /> : null}
      {formatted}
    </a>
  );
}
