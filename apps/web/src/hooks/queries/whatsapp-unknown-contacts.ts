// T-E2b follow-up queue - React Query hooks.
//
// Wire shape (per the BFF catch-all that proxies GET/POST
// /api/whatsapp-unknown-contacts):
//
//   useWaUnknownContacts({ status, limit, cursor })
//     → GET /api/whatsapp-unknown-contacts
//       returns { total: number, rows: WhatsappUnknownContactRow[], nextCursor: string | null }
//
//   useConvertWaUnknownContact()
//     → POST /api/whatsapp-unknown-contacts/:id/convert  body: CreateLeadDto
//       returns { lead: {...}, contact: WhatsappUnknownContactRow }
//       The backend service ALREADY creates the Lead (via LeadsService.createInTransaction
//       inside one tx) AND flips the contact to CONVERTED - there is NO separate
//       useCreateLead call. Doing both would create two Leads (atom violated).
//
//   useMarkWaUnknownSpam()
//     → POST /api/whatsapp-unknown-contacts/:id/spam  no body
//       returns { contact: WhatsappUnknownContactRow }
//
// On success, the convert + spam mutations invalidate the list query so
// the queue refetches without a manual refresh. They also invalidate
// ['leads'] because convert() creates a new Lead that the inbox needs
// to surface.

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api, qs } from '@/apis/client';
import { invalidateLeadCaches } from '@/hooks/queries/crm';

import type {
  ConvertUnknownContactDto,
  ConvertUnknownContactResult,
  SpamUnknownContactResult,
  WhatsappUnknownContactListQuery,
  WhatsappUnknownContactListResult,
  WhatsappUnknownContactRow,
} from '@shadhil/api-types';

// ---------------------------------------------------------------------------
// List (GET /api/whatsapp-unknown-contacts)
// ---------------------------------------------------------------------------

export function useWaUnknownContacts(
  query: Partial<WhatsappUnknownContactListQuery> = {},
) {
  return useQuery({
    queryKey: ['whatsapp-unknown-contacts', query] as const,
    queryFn: ({ signal }) =>
      api<WhatsappUnknownContactListResult>(
        `/whatsapp-unknown-contacts${qs({
          status: query.status,
          limit: query.limit,
          cursor: query.cursor,
        })}`,
        { signal },
      ),
    select: (raw): WhatsappUnknownContactListResult => ({
      total: typeof raw.total === 'number' ? raw.total : 0,
      rows: Array.isArray(raw.rows) ? raw.rows : [],
      nextCursor:
        typeof raw.nextCursor === 'string' && raw.nextCursor.length > 0
          ? raw.nextCursor
          : null,
    }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Convert (POST /api/whatsapp-unknown-contacts/:id/convert)
//
// Body shape is CreateLeadDto (the same DTO POST /api/leads accepts).
// The service normalizes `source` to 'WHATSAPP' regardless of what the
// UI sends - we still pre-set it so the form's visual state is honest.
// ---------------------------------------------------------------------------

export function useConvertWaUnknownContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: ConvertUnknownContactDto }) =>
      api<ConvertUnknownContactResult>(
        `/whatsapp-unknown-contacts/${args.id}/convert`,
        { method: 'POST', json: args.body },
      ),
    onSuccess: () => {
      // The list must refetch - convert flips the contact to CONVERTED
      // and adds a row to the Leads inbox. KPI strip counts bump too.
      void queryClient.invalidateQueries({
        queryKey: ['whatsapp-unknown-contacts'],
      });
      invalidateLeadCaches(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// Spam (POST /api/whatsapp-unknown-contacts/:id/spam)
// ---------------------------------------------------------------------------

export function useMarkWaUnknownSpam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string }) =>
      api<SpamUnknownContactResult>(
        `/whatsapp-unknown-contacts/${args.id}/spam`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['whatsapp-unknown-contacts'],
      });
    },
  });
}

// Type re-exports for convenience - pages can `import { WhatsappUnknownContactRow }`
// from this module instead of pulling @shadhil/api-types into the page tree.
export type { WhatsappUnknownContactRow };