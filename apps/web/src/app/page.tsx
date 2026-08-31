import { env } from '@/lib/env/env';
import { Button, Card, Heading, TypographyP } from '@paalstack/react-ui';

// Force dynamic rendering: the wrapped Providers reads localStorage on mount
// (theme persistence) and Next 16's static prerender chokes on that.
export const dynamic = 'force-dynamic';

export default function Home(): React.JSX.Element {
  return (
    <main className="container mx-auto max-w-5xl py-16">
      <div className="mb-12">
        <Heading className="mb-2">{env.NEXT_PUBLIC_APP_NAME}</Heading>
        <TypographyP className="text-muted-foreground">
          Real-estate CRM for Shadhil Builders — Lead Inbox, Site Visits, Bookings, Chat,
          Reminders, Notifications. Built on Next.js 16, NestJS 12, and Prisma 18 models with
          Postgres RLS.
        </TypographyP>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <Heading className="mb-2">Lead Inbox</Heading>
          <TypographyP className="text-muted-foreground mb-4">
            Telecaller queue with state machine (NEW → VISIT_SCHEDULED → WON).
          </TypographyP>
          <Button variant="secondary" disabled>
            Coming Week 4
          </Button>
        </Card>

        <Card>
          <Heading className="mb-2">API Docs</Heading>
          <TypographyP className="text-muted-foreground mb-4">
            REST + SSE documentation served by the NestJS backend.
          </TypographyP>
          <Button variant="default" asChild>
            <a href="/api/docs">Open Swagger</a>
          </Button>
        </Card>

        <Card>
          <Heading className="mb-2">Auth</Heading>
          <TypographyP className="text-muted-foreground mb-4">
            better-auth + Prisma adapter. Organization plugin intentionally excluded — Team is
            the single grouping.
          </TypographyP>
          <Button variant="secondary" disabled>
            Coming Week 3
          </Button>
        </Card>
      </div>

      <div className="text-muted-foreground mt-12 text-sm">
        <TypographyP>
          Backend: <code>{env.NEXT_PUBLIC_API_BASE_URL}</code> · Phase 1 scaffold complete.
          Build (Week 1–2) is done; auth flows, Lead Inbox, and mobile app come in Weeks 3–10.
        </TypographyP>
      </div>
    </main>
  );
}
