import { Suspense } from 'react';
import { type Metadata } from 'next';

import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = {
  title: 'Create your organization',
};

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
