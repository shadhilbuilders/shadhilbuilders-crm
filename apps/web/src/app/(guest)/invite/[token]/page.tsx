// /invite/[token] - the staff member opens their invite.
//
// Server component: resolves the preview BEFORE rendering, so an expired or
// revoked link shows its own card rather than an empty form that fails on
// submit. Public route (no session) - the token in the path is the credential.
//
// Each terminal state gets a card with ONE clear next action, because a staff
// member hitting a dead invite on a phone has no other way forward. Sharing a
// single "invalid link" screen would leave them with nothing to do.
import { Card, Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';

import { getInvitePreview, type InvitePreviewFailure } from '@/lib/server/invite-preview';

import { AcceptInviteForm } from './AcceptInviteForm';

export const dynamic = 'force-dynamic';

/** Copy per failure kind - title, explanation, and the next step. */
function failureCopy(failure: InvitePreviewFailure): {
  heading: string;
  body: string;
  action?: { label: string; href: string };
} {
  switch (failure.kind) {
    case 'expired':
      return {
        heading: 'This invite has expired',
        body: 'Invite links are valid for 7 days. Ask your admin to send a new one.',
        action: { label: 'Go to sign in', href: '/login' },
      };
    case 'revoked':
      return {
        heading: 'This invite was revoked',
        body: 'Your admin cancelled this invite. Ask them to send a new one.',
        action: { label: 'Go to sign in', href: '/login' },
      };
    case 'accepted':
      return {
        heading: 'This invite has already been used',
        body: 'Your account exists. Sign in with the email and password you set.',
        action: { label: 'Sign in', href: '/login' },
      };
    case 'unavailable':
      return {
        heading: 'We could not load this invite',
        body: 'This is usually temporary. Refresh the page to try again.',
      };
    case 'invalid':
    default:
      return {
        heading: 'This link is not valid',
        body: 'Check the link you were sent, or ask your admin for a new invite.',
        action: { label: 'Go to sign in', href: '/login' },
      };
  }
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getInvitePreview(token);

  return (
    // w-full max-w-sm: the same card shape LoginForm / RegisterForm use, so
    // this surface is indistinguishable from the rest of the guest shell. On a
    // 320px screen that is 288px of content - no side-by-side field pairs.
    <Card className="w-full max-w-sm">
      {result.ok ? (
        <>
          <div className="mb-6 space-y-1 text-center">
            <Heading className="mb-1">Join {result.data.organizationName}</Heading>
            <TypographyP className="text-muted-foreground text-sm">
              You have been invited as{' '}
              <span className="text-foreground font-medium">
                {roleLabel(result.data.role)}
              </span>
              {result.data.teamName !== null ? ` on ${result.data.teamName}` : ''}.
            </TypographyP>
          </div>
          <AcceptInviteForm token={token} preview={result.data} />
        </>
      ) : (
        <FailureCard failure={result.failure} />
      )}
    </Card>
  );
}

function FailureCard({ failure }: { failure: InvitePreviewFailure }) {
  const copy = failureCopy(failure);
  return (
    // role="status": a terminal state is a message, not an error the user
    // caused, and it should be announced without interrupting.
    <div className="space-y-3 text-center" role="status" data-qa={`invite-failure-${failure.kind}`}>
      <Heading className="mb-1">{copy.heading}</Heading>
      <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
        {copy.body}
      </TypographyP>
      {copy.action !== undefined ? (
        <TypographyP className="mt-4 text-sm">
          <Link href={copy.action.href} className="text-link underline underline-offset-4">
            {copy.action.label}
          </Link>
        </TypographyP>
      ) : null}
    </div>
  );
}

/** Human label for the invited role. Kept local so the page owns no imports
 *  from the admin tree. */
function roleLabel(role: string): string {
  const map: Record<string, string> = {
    ADMIN: 'an admin',
    MANAGER: 'a manager',
    SALES_EXEC: 'a sales executive',
    TELECALLER: 'a telecaller',
    ENGINEER: 'a site engineer',
  };
  return map[role] ?? 'a team member';
}
