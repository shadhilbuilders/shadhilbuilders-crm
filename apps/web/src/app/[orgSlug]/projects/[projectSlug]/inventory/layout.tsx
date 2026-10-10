import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Inventory',
};

export default function InventoryLayout({ children }: { children: ReactNode }) {
  return children;
}
