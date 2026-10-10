import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'WhatsApp Chats',
};

export default function WhatsAppChatLayout({ children }: { children: ReactNode }) {
  return children;
}
