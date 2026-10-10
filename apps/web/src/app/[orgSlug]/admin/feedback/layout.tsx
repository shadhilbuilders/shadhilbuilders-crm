import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Feedback',
};

export default function AdminFeedbackLayout({ children }: { children: ReactNode }) {
  return children;
}
