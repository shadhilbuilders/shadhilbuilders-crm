'use client';

// Reveal: wraps a block (or list item) with the scroll-in entrance. `delayMs`
// staggers siblings; it is capped so a long list never waits on its tail.
import type { CSSProperties, ReactNode } from 'react';

import { useReveal } from '@/hooks/use-reveal';

const MAX_DELAY_MS = 240;

export function Reveal({
  as = 'div',
  className = '',
  delayMs = 0,
  children,
  ...rest
}: {
  as?: 'div' | 'li' | 'section';
  className?: string;
  delayMs?: number;
  children: ReactNode;
} & { id?: string; 'aria-labelledby'?: string } & {
  [K in `data-${string}`]?: string | undefined;
}) {
  const ref = useReveal<HTMLElement>();
  const style: CSSProperties | undefined =
    delayMs > 0 ? { transitionDelay: `${Math.min(delayMs, MAX_DELAY_MS)}ms` } : undefined;
  const props = { ref: ref as never, className: `portal-reveal ${className}`.trim(), style, ...rest };
  if (as === 'li') return <li {...props}>{children}</li>;
  if (as === 'section') return <section {...props}>{children}</section>;
  return <div {...props}>{children}</div>;
}
