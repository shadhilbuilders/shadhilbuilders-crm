import { cn } from '@paalstack/react-ui/lib';
import { type Metadata, type Viewport } from 'next';
import { Inter } from 'next/font/google';
import NextTopLoader from 'nextjs-toploader';
import { type ReactNode } from 'react';

import { SiteHeader } from '@/components/SiteHeader';
import { Providers } from '@/providers';

import '@/styles/globals.css';

// Inter — brand font. Loaded via next/font (self-hosted, preloaded,
// no external Google Fonts CDN requests). The `--font-inter` CSS
// variable that next/font sets on <body> is wired to Tailwind's
// `font-sans` utility via `--font-sans` in apps/web/src/styles/globals.css.
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    template: '%s | Shadhil Builders CRM',
    default: 'Shadhil Builders CRM',
  },
  description:
    'Real-estate CRM for Shadhil Builders — Lead Inbox, Site Visits, Bookings, Chat, Reminders.',
  keywords: ['CRM', 'Real Estate', 'Shadhil Builders', 'Lead Management'],
  authors: [{ name: 'PaalStack' }],
  creator: 'Shadhil Builders',
  openGraph: {
    type: 'website',
    locale: 'en_IN',
    title: 'Shadhil Builders CRM',
    description: 'Real-estate CRM for Shadhil Builders',
    siteName: 'Shadhil Builders CRM',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Shadhil Builders CRM',
    description: 'Real-estate CRM for Shadhil Builders',
  },
  robots: {
    index: false, // Internal CRM — not indexed
    follow: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Do NOT pin maximumScale — pinch-zoom is a WCAG 1.4.4 accessibility
  // requirement (and Android Chrome honors the pin, locking out low-vision
  // users). iOS ignores it anyway.
  viewportFit: 'cover', // let content extend under notches; safe-area padding below
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f5ef' }, // brand surface
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1e' }, // dark surface
  ],
};

type RootLayoutProps = {
  children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProps) => {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn(inter.variable, 'antialiased font-sans')}>
        <NextTopLoader showSpinner={false} height={5} color="#62b132" />
        <Providers>
          <SiteHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
};

export default RootLayout;
