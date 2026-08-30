import { Heading, TypographyP } from '@paalstack/react-ui';

// Force dynamic rendering — the wrapped Providers reads localStorage on
// mount (theme persistence) and Next 16's static prerender chokes on that.
export const dynamic = 'force-dynamic';

export default function NotFound(): React.JSX.Element {
  return (
    <main className="container mx-auto max-w-3xl py-24 text-center">
      <Heading className="mb-2">Page not found</Heading>
      <TypographyP className="text-muted-foreground">
        The page you were looking for doesn't exist or has moved.
      </TypographyP>
    </main>
  );
}
