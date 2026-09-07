import { GuestTopBar } from '@/components/guest-top-bar';
import { Heading, TypographyP } from '@paalstack/react-ui';

// Force dynamic rendering - the wrapped Providers reads localStorage on
// mount (theme persistence) and Next 16's static prerender chokes on that.
export const dynamic = 'force-dynamic';

export default function NotFound(): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <GuestTopBar />
      <main className="text-ink container mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center px-4 text-center">
        <Heading className="mb-2">Page not found</Heading>
        <TypographyP className="text-muted-foreground">
          The page you were looking for doesn't exist or has moved.
        </TypographyP>
      </main>
    </div>
  );
}