import { cn } from '@paalstack/react-ui/lib';
import { type Metadata, type Viewport } from 'next';
import { IBM_Plex_Sans } from 'next/font/google';
import NextTopLoader from 'nextjs-toploader';
import { type ReactNode } from 'react';

import { SiteHeader } from '@/components/SiteHeader';
import { Providers } from '@/providers';

import '@shadhil/ui-tokens/fonts.css';
import '@shadhil/ui-tokens/tokens.css';
import '@/styles/globals.css';

// IBM Plex Sans — locked brand font per plan §4.
// Inter and Geist are explicitly excluded.
const ibmPlexSans = IBM_Plex_Sans({
  variable: '--font-ibm-plex-sans',
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
  maximumScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f5ef' }, // brand surface
  ],
};

type RootLayoutProps = {
  children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProps) => {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn(ibmPlexSans.variable, 'antialiased font-sans')}>
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
