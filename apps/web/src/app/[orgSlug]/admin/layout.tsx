'use client';

// Admin namespace gate. OWNER/ADMIN only (isAdminLike). This is a UX
// mirror of backend + RLS; the server remains the security boundary.
import { type ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { Heading, TypographyP } from '@paalstack/react-ui';

import { Skeleton } from '@/components/shared/Skeleton';
import { isAdminLike, useSessionUser } from '@/lib/session';

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, isPending } = useSessionUser();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isPending) {
    return <Skeleton variant="overview" className="py-4" />;
  }

  if (user === null) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Session expired.{' '}
          <Link href="/login" className="underline">
            Sign in again
          </Link>
          .
        </TypographyP>
      </div>
    );
  }

  if (!isAdminLike(user.role)) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only owners and admins can open Admin.
        </TypographyP>
      </div>
    );
  }

  return children;
}
