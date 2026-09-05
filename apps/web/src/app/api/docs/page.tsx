// OpenAPI docs - proxy to NestJS Swagger UI at /api/docs.
// This is the BFF rewrite target (see next.config.ts).
import { env } from '@/lib/env/env';
import { Button, Heading, TypographyP } from '@paalstack/react-ui';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'API Docs',
  description: 'Shadhil Builders CRM - REST API + SSE streams (OpenAPI 3.0)',
};

export default function ApiDocsPage(): React.JSX.Element {
  return (
    <main className="container mx-auto max-w-3xl py-16">
      <div className="flex flex-col gap-4">
        <Heading>API Documentation</Heading>
        <TypographyP className="text-muted-foreground">
          The Shadhil Builders CRM REST API is documented with OpenAPI 3.0. The Swagger UI is
          served by the NestJS backend.
        </TypographyP>
        <div className="flex flex-col gap-3">
          <Button variant="default" asChild>
            <a href={`${env.NEXT_PUBLIC_API_BASE_URL}/api/docs`} target="_blank" rel="noreferrer">
              Open Swagger UI
            </a>
          </Button>
          <Button variant="secondary" asChild>
            <a
              href={`${env.NEXT_PUBLIC_API_BASE_URL}/api/docs-json`}
              target="_blank"
              rel="noreferrer"
            >
              Download OpenAPI JSON
            </a>
          </Button>
        </div>
      </div>
    </main>
  );
}
