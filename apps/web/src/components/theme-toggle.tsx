'use client';

// ThemeToggle - light/dark mode switch (icon button) for the topbar.
//
// Uses `@paalstack/react-ui`'s `useNextTheme` hook (a re-export of the
// SSR-safe `next-themes` `useTheme` wrapper) to read the current
// theme + set the new one. The library's homegrown `useTheme` is the
// shadhil-crm-dev skill's explicit anti-recommendation (per
// apps/web/src/README.md:266-271 - it calls setTheme('dark')
// directly and breaks SSR), so we use the Next-safe one here.
//
// Two-state (light ↔ dark) by design. The provider at
// apps/web/src/providers/providers.tsx wires defaultTheme="system"
// with enableSystem, so on first paint the page respects the OS
// preference; the button then lets the user override to a fixed
// mode. The "system" value is a third option but exposing it would
// require a 3-way dropdown - too much surface for a topbar icon
// button. The shadcn default for the "next-themes" toggle is also
// two-state (sun/moon) so this is the conventional shape.
//
// Hydration: `resolvedTheme` is `undefined` until the client mounts
// (next-themes' default - avoids a light/dark flash on first paint).
// We render a neutral "Loading…" icon button while mounted=false so
// the SSR markup is the same as the initial client markup (no
// hydration mismatch warning) and swap to the proper sun/moon icon
// after mount.
//
// Testability: the inner button JSX is exported as `ThemeToggleButton`
// so the wire-shape contract (icon, label, click handler) can be
// tested via renderToStaticMarkup without mounting the next-themes
// context. The public `ThemeToggle` is a thin wrapper that
// subscribes to the context and forwards the click.
import { useEffect, useState, type ReactNode } from 'react';

import { Button, useNextTheme } from '@paalstack/react-ui';
import { LuMoon, LuSun } from '@paalstack/react-icons/lu';

export type ThemeToggleButtonProps = {
  /** The icon to render. Tests inject a deterministic node. */
  icon: ReactNode;
  /** What the button announces to assistive tech. */
  label: string;
  /** What the button renders as its data-qa-theme-mode attribute. */
  mode: 'light' | 'dark' | 'unknown';
  /** Click handler - tests inject a vi.fn. */
  onClick: () => void;
  /** Optional className for layout (e.g. min-h-11 sizing). */
  className?: string;
};

/**
 * The pure button - no hooks, no context. Rendered both by the
 * public `ThemeToggle` (with a live icon from useNextTheme) and by
 * the unit test (with a stub icon + spy onClick).
 */
export function ThemeToggleButton({
  icon,
  label,
  mode,
  onClick,
  className,
}: ThemeToggleButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ?? 'my-1.5 min-h-12 min-w-12 px-2.5'}
      onClick={onClick}
      aria-label={label}
      data-qa="theme-toggle"
      data-theme-mode={mode}
    >
      {icon}
    </Button>
  );
}

/** Public component - subscribes to the next-themes context. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useNextTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';
  const nextTheme = isDark ? 'light' : 'dark';
  const label = mounted
    ? isDark
      ? 'Switch to light mode'
      : 'Switch to dark mode'
    : 'Toggle theme';
  const Icon = isDark ? LuSun : LuMoon;

  return (
    <ThemeToggleButton
      icon={<Icon className="size-5" />}
      label={label}
      mode={mounted ? (isDark ? 'dark' : 'light') : 'unknown'}
      onClick={() => setTheme(nextTheme)}
    />
  );
}
