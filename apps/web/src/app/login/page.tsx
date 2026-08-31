import { Suspense } from 'react';
import { type Metadata } from 'next';

import { LoginForm } from './LoginForm';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    <main className="text-ink flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}