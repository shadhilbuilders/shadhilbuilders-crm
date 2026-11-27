'use client';

// The signed-in person's photo, in one place (2026-11-26).
//
// SessionUser carries no image: `{ id, name, email, role }` only. So the id
// comes from the session and the render URL from the user-detail query, which
// every role may call for itself. The server resolves the storage key, so the
// browser never builds a media path of its own. The query is cached
// (`staleTime` 30s) and invalidated by `useUpdateProfile` after a save, so a new
// photo appears without a hard reload.
//
// Why this component exists: the sidebar footer had the photo and the topbar's
// account menu had a generic silhouette, so the same person appeared two
// different ways in two corners of the same screen. Both menus render this now,
// which is also why the shape lives here: one avatar shape, one fallback rule.
import { Avatar } from '@paalstack/react-ui';

import { useUser } from '@/hooks/queries/users';
import { initials } from '@/lib/initials';
import { useSessionUser } from '@/lib/session';

/** The house shape for an account avatar: 32px, a circle (see AvatarUpload). */
export function SelfAvatar({ name }: { name: string }) {
  const { user } = useSessionUser();
  const selfQuery = useUser(user?.id);
  return (
    <Avatar
      // 2026-11-27: every avatar in the shell is a circle. `rounded-lg` read as
      // a square chip beside the round avatars elsewhere (AvatarUpload).
      className="h-8 w-8 shrink-0 rounded-full"
      src={selfQuery.data?.imageUrl ?? undefined}
      alt=""
      fallback={initials(name)}
      imageProps={{ className: 'rounded-full' }}
      fallbackProps={{ className: 'rounded-full text-xs' }}
    />
  );
}
