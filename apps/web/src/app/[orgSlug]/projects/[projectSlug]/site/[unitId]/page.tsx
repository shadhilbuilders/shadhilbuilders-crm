// /site/[unitId]: server wrapper for the capture screen.
//
// The capture screen is a client component, so it cannot read `process.env`.
// This wrapper reads SITE_VIDEO_CAPTURE on the server and hands the client a
// plain boolean; with the flag off the screen is exactly the photo-only one.
import { SiteCapturePage } from '@/components/site/SiteCapturePage';
import { isSiteVideoEnabled } from '@/lib/site-video/flag';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <SiteCapturePage videoEnabled={isSiteVideoEnabled(process.env)} />;
}
