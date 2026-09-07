import type { ReactNode } from 'react';

import { GuestTopBar } from '@/components/guest-top-bar';

// Shared layout for guest-facing pages: /login, /change-password,
// /offline. Authenticated work surfaces use (app)/layout.tsx instead
// (AppShell + AppHeader).
export default function GuestLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <GuestTopBar />
      <main
        className="text-ink flex flex-1 flex-col items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      >
        {children}
      </main>
    </div>
  );
}
