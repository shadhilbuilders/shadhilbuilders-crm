import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Webhook Events',
};

export default function AdminWebhooksLayout({ children }: { children: ReactNode }) {
  return children;
}
