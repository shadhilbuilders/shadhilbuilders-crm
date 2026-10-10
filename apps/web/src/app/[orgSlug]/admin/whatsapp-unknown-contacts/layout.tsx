import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'WhatsApp Unknown Contacts',
};

export default function AdminWhatsAppUnknownContactsLayout({ children }: { children: ReactNode }) {
  return children;
}
