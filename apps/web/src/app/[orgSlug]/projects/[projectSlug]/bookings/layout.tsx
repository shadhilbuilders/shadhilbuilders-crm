import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Bookings',
};

export default function BookingsLayout({ children }: { children: ReactNode }) {
  return children;
}
