import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Booking Details',
};

export default function BookingDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
