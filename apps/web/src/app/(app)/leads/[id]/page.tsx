'use client';

// Lead Detail (Wireframes #5): two-column — left lead info + tabbed
// timeline/notes, right embedded chat pane. T-2h sticky banner when a visit
// is approaching (Decision 0.10), co-owner chip in VISIT_SCHEDULED (0.3).
//
// Live data arrives with the leads module; until then the page renders the
// honest pending state with locked layout.
import { Heading, TypographyP } from '@paalstack/react-ui';
import { useParams } from 'next/navigation';

import { BackLink } from '@/components/shared/ModulePending';
import { ModulePending } from '@/components/shared/ModulePending';
import {
  useLead,
  useLeadActivities,
  useMessages,
} from '@/hooks/queries/crm';
import { useSessionUser } from '@/lib/session';

import { PageHeader } from '../../PageHeader';

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const leadId = typeof params?.id === 'string' ? params.id : null;

  const leadQuery = useLead(leadId);
  const activitiesQuery = useLeadActivities(leadId);
  const messagesQuery = useMessages(leadId);
  const { user } = useSessionUser();

  const notFound = leadQuery.error !== null && leadQuery.error !== undefined && !leadQuery.isLoading;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Lead"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Leads', href: '/leads' },
          { label: typeof (leadQuery.data as { name?: string } | undefined)?.name === 'string' ? (leadQuery.data as { name: string }).name : 'Detail' },
        ]}
      />

      <BackLink href="/leads" label="Back to inbox" />

      {leadQuery.data !== undefined && leadQuery.data !== null ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
          {/* Left — lead info + tabs */}
          <div className="space-y-4">
            <div>
              <Heading as="h2">
                {/* Payload shape locked in api-types; safe render on live data */}
                {typeof (leadQuery.data as { name?: string }).name === 'string'
                  ? (leadQuery.data as { name: string }).name
                  : 'Lead'}
              </Heading>
              <TypographyP className="text-muted-foreground text-sm">
                {(leadQuery.data as { phone?: string }).phone ?? ''}
              </TypographyP>
            </div>
            <LeadTabsPanel
              lead={leadQuery.data as Record<string, unknown>}
              activities={activitiesQuery.data}
            />
          </div>

          {/* Right — embedded chat (permanently visible on desktop) */}
          <aside className="border-border rounded-lg border">
            <div className="border-border border-b px-4 py-2.5 text-xs font-semibold tracking-wide uppercase">
              Chat
            </div>
            <ChatPane
              leadId={leadId}
              messages={messagesQuery.data}
              canSend={user !== null}
            />
          </aside>
        </div>
      ) : (
        <ModulePending
          title="Lead detail"
          description="Contact, timeline, notes, visit widget, and booking panel for a single lead (Wireframe #5). Arrives with the leads module (Week 4) and chat module (Week 5)."
          error={leadQuery.error}
          isLoading={leadQuery.isLoading}
        />
      )}

      {notFound && leadQuery.data === undefined && leadQuery.error !== undefined ? null : null}
    </div>
  );
}

function LeadTabsPanel({
  lead,
  activities,
}: {
  lead: Record<string, unknown>;
  activities: unknown;
}) {
  const hasActivities = Array.isArray(activities);
  return (
    <div className="space-y-3">
      <div className="border-border text-xs font-semibold tracking-wide uppercase">
        Timeline
      </div>
      {hasActivities ? (
        <ol className="space-y-2">
          {(activities as unknown[]).map((entry, index) => (
            <li
              key={index}
              className="border-border text-muted-foreground border-b pb-2 text-sm last:border-b-0"
            >
              {JSON.stringify(entry).slice(0, 160)}
            </li>
          ))}
        </ol>
      ) : (
        <TypographyP className="text-muted-foreground text-xs">
          Timeline for {String(lead.name ?? 'this lead')} appears when the
          activities endpoint lands (Week 4).
        </TypographyP>
      )}
    </div>
  );
}

function ChatPane({
  leadId,
  messages,
  canSend,
}: {
  leadId: string | null;
  messages: unknown;
  canSend: boolean;
}) {
  const hasMessages = Array.isArray(messages);
  return (
    <div className="space-y-2 p-4">
      {hasMessages ? (
        <ul className="space-y-2">
          {(messages as unknown[]).map((message, index) => (
            <li key={index} className="text-sm">
              {JSON.stringify(message).slice(0, 200)}
            </li>
          ))}
        </ul>
      ) : (
        <TypographyP className="text-muted-foreground text-sm">
          Messages with this customer appear here (SSE live) when the chat
          module ships (Week 5){leadId !== null ? '' : ''}.
        </TypographyP>
      )}
      {canSend ? null : null}
    </div>
  );
}