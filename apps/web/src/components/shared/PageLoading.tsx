import { Loading } from '@paalstack/react-ui';

const MIN_HEIGHT_CLASSES = {
  // Full viewport minus the 64px app header - used for top-level route
  // loading states (root redirect, org home, org loading.tsx).
  full: 'min-h-[calc(100dvh-64px)]',
  // Shorter, used inside a page body that already renders its own chrome
  // (e.g. project loading.tsx nested under a layout with its own header).
  section: 'min-h-[60vh]',
} as const;

/**
 * Full-section loading state used by route-level `loading.tsx` files and
 * pages that block on a redirect/session resolution. Centers
 * @paalstack/react-ui's `Loading` in a container tall enough to avoid
 * layout jump once content resolves.
 */
export function PageLoading({
  content = 'Loading...',
  className = 'text-foreground',
  minHeight = 'full',
}: {
  content?: string;
  className?: string;
  minHeight?: keyof typeof MIN_HEIGHT_CLASSES;
}) {
  return (
    <div className={`flex ${MIN_HEIGHT_CLASSES[minHeight]} w-full items-center justify-center`}>
      <Loading content={content} className={className} spinnerProps={{ size: 'lg' }} />
    </div>
  );
}
