import type { ReactNode } from 'react';

import { GuestTopBar } from '@/components/guest-top-bar';

// Shared layout for guest-facing pages: /login, /change-password,
// /offline. Authenticated work surfaces use (app)/layout.tsx instead
// (AppShell + AppHeader).
export default function GuestLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <GuestTopBar />
      {/* T-SafeArea: top inset is now reserved by GuestTopBar itself (it's
          sticky above this <main>), so this only needs a plain top gap -
          doubling the notch inset here would push content down twice on
          iOS. Bottom still needs the inset (home-indicator safe area, no
          chrome below it to absorb it). */}
      <main
        className="text-ink flex flex-1 flex-col items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4"
      >
        {children}
      </main>
    </div>
  );
}
