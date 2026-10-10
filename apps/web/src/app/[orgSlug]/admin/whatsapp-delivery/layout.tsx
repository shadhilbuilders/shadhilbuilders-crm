import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'WhatsApp Delivery',
};

export default function AdminWhatsAppDeliveryLayout({ children }: { children: ReactNode }) {
  return children;
}
