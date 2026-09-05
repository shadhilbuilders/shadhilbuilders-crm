import { Suspense } from 'react';
import { type Metadata } from 'next';

import { AuthTopBar } from '@/components/auth-top-bar';

import { LoginForm } from './LoginForm';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    <div className="bg-background flex min-h-[100dvh] flex-col">
      <AuthTopBar />
      <main className="text-ink flex flex-1 items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </main>
    </div>
  );
}