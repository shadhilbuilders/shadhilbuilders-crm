'use client';

// usePortalRefresh: the query plumbing behind the portal's Refresh action.
//
// WHY A HOOK, NOT A COMPONENT (2026-11-09): the action is an ordinary library
// <Button>, so there is no custom button to maintain - the only thing worth
// owning is the cache behaviour and its busy/announcement state.
//
// It invalidates the whole `customer-portal` key prefix rather than one query:
// a new upload changes the unit's photo count, the timeline AND the stage shown
// in the journey, so a partial refresh would leave the header disagreeing with
// the feed below it.
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { toast } from '@paalstack/react-ui';

/** Every portal query hangs off this prefix (see hooks/queries/customer-portal). */
const PORTAL_KEY = ['customer-portal'] as const;

export type PortalRefresh = {
  /** True while this button's request or any portal refetch is in flight. */
  busy: boolean;
  /** Polite result text for a live region; empty until a refresh finishes. */
  announcement: string;
  refresh: () => Promise<void>;
};

export function usePortalRefresh(): PortalRefresh {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const fetching = useIsFetching({ queryKey: PORTAL_KEY }) > 0;

  const refresh = async (): Promise<void> => {
    if (pending || fetching) return;
    setPending(true);
    setAnnouncement('');
    try {
      await queryClient.invalidateQueries({ queryKey: PORTAL_KEY });
      setAnnouncement('Updated just now');
    } catch {
      // invalidateQueries rejects only when a refetch throws; the queries keep
      // their own error state, so surface it rather than failing silently.
      toast.error('Could not refresh. Please try again.');
      setAnnouncement('Refresh failed');
    } finally {
      setPending(false);
    }
  };

  return { busy: pending || fetching, announcement, refresh };
}
