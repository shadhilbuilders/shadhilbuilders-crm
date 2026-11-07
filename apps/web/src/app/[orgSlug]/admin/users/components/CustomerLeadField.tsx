'use client';

// "Customer (lead)" picker for the Create user form (issue #8 slice 2).
// A CUSTOMER login must point at the Lead it belongs to; this searches leads
// by name or phone and reports the chosen lead id. It is its own component so
// the leads request is mounted ONLY while a CUSTOMER role is selected - every
// other role never triggers a leads fetch from this dialog.
//
// Remote search runs through the Combobox's own `fetchOptions` (it debounces
// and aborts the in-flight request) rather than an input state fed into a
// TanStack query, which used to keep one cache entry - and one request - per
// keystroke. The first page of leads is still passed as `options`, so the
// dropdown is populated the moment it opens instead of only after typing.
// Mirrors LeadReassignDialog / LeadCoOwnerDialog (T-USER-PROJECT-SCOPE pickers).
import { Combobox } from '@paalstack/react-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, qs } from '@/apis/client';
import { useLeads } from '@/hooks/queries/crm';

/** Page size for both the initial list and each remote search. */
const LEAD_LIMIT = 20;
/** The Combobox's default is 300ms; leads are a heavier scan (name OR phone
 *  ILIKE) than the staff picker, so a longer settle keeps it to one request. */
const LEAD_SEARCH_DEBOUNCE_MS = 500;

type LeadOption = { id: string; name: string; phone: string };
type LeadChoice = { value: string; label: string };

/** The leads list is untyped at the hook boundary; narrow the two fields we render. */
export function toLeadOptions(rows: unknown): LeadChoice[] {
  if (!Array.isArray(rows)) return [];
  const options: LeadChoice[] = [];
  for (const row of rows as Partial<LeadOption>[]) {
    if (row && typeof row.id === 'string' && typeof row.name === 'string') {
      options.push({
        value: row.id,
        label: typeof row.phone === 'string' ? `${row.name} - ${row.phone}` : row.name,
      });
    }
  }
  return options;
}

/**
 * GET /leads?search=&limit= - the same role-scoped list the inbox uses.
 * Returns [] for an empty query: the Combobox already skips the call, and an
 * empty box must never dump the org's leads into the dropdown.
 */
export async function fetchLeadOptions(query: string): Promise<LeadChoice[]> {
  const search = query.trim();
  if (search.length === 0) return [];
  const res = await api<{ rows?: unknown } | unknown[]>(
    `/leads${qs({ search, limit: LEAD_LIMIT })}`,
  );
  // The endpoint answers with the paginated `{ total, rows }` envelope; a bare
  // array is accepted too so a contract change can't silently empty the picker.
  const rows = Array.isArray(res) ? res : (res?.rows ?? []);
  return toLeadOptions(rows);
}

/**
 * `errorMessage` is deliberately NOT a prop: react-ui's Form already renders
 * the field error once (`form-error-message-<name>`) for every non-`field`
 * item, so also handing it to the Combobox printed the same sentence twice.
 * `isInvalid` is still forwarded so the control itself reads as an error.
 */
export function CustomerLeadField({
  value,
  onChange,
  isInvalid,
}: {
  value: string | undefined;
  onChange: (leadId: string | undefined) => void;
  isInvalid: boolean;
}) {
  // The Combobox only renders a selected value's LABEL if the option is in the
  // list it currently holds (`itemToStringLabel` falls back to the raw value).
  // Remote results are discarded as soon as the search box empties, so a pick
  // made from a search would otherwise show the lead's uuid in the trigger.
  const [picked, setPicked] = useState<LeadChoice | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const lastResults = useRef<LeadChoice[]>([]);

  // First page, shown before the user types (same pattern as the staff pickers).
  const { data: firstPage } = useLeads({ limit: LEAD_LIMIT });
  const options = useMemo(() => {
    const base = toLeadOptions(firstPage);
    if (!picked) return base;
    return [picked, ...base.filter((option) => option.value !== picked.value)];
  }, [firstPage, picked]);

  const fetchOptions = useCallback(async (query: string) => {
    try {
      const results = await fetchLeadOptions(query);
      lastResults.current = results;
      setSearchFailed(false);
      return results;
    } catch (error) {
      // react-ui's Combobox swallows a rejected fetchOptions and renders an
      // empty list, so an outage would read as "no such lead". Flag it and
      // re-throw (dropping the error would be the silent failure this repo
      // forbids) - the empty message below says what actually happened.
      setSearchFailed(true);
      throw error;
    }
  }, []);

  // The dialog resets the field between openings; drop the stale label with it.
  useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  return (
    <Combobox
      value={value ?? ''}
      options={options}
      placeholder="Search a lead by name or phone..."
      data-qa="create-user-customer-lead"
      fetchOptions={fetchOptions}
      fetchDebounce={LEAD_SEARCH_DEBOUNCE_MS}
      emptyOptionMessage={
        searchFailed
          ? 'Could not search leads - check the connection and type again.'
          : 'No leads matched that search.'
      }
      isInvalid={isInvalid}
      loadingMessage="Searching leads..."
      // Always drop DOWN. Create-dialog pickers sit near the bottom of a
      // scrollable dialog, so Base UI's default collision avoidance flipped
      // the list ABOVE the input (reported 2026-11-06). `side: 'none'` keeps
      // the preferred side and lets the popup be clamped to the room that is
      // actually there (it already caps at max-h-(--available-height)), which
      // needs the local @paalstack/react-ui patch exposing these two props.
      contentProps={{ collisionAvoidance: { side: 'none', align: 'shift' }, side: 'bottom' }}
      onValueChange={(next) => {
        setPicked(next ? (lastResults.current.find((o) => o.value === next) ?? null) : null);
        onChange(next ?? undefined);
      }}
    />
  );
}
