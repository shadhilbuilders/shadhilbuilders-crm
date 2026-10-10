import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'New Booking',
};

export default function NewBookingLayout({ children }: { children: ReactNode }) {
  return children;
}
