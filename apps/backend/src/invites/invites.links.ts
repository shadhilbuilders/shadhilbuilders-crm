// Server-side derivation of the invite's share links (2026-11-20).
//
// WHY THIS IS SERVER-SIDE. Two reasons, both concrete:
//
// 1. `wa.me` requires the DIGITS-ONLY form. Our stored phone is
//    `91XXXXXXXXXX` (no `+`), which is exactly right; a stray `+` in the path
//    silently 404s rather than erroring, so getting this wrong produces a
//    dead link with no diagnostic. One tested implementation beats a
//    hand-rolled template string at each call site.
//
// 2. The message names the ORG. That value must come from the invite's own
//    organization - resolved server-side - so a client cannot construct a
//    message naming someone else's tenant.
//
// WHAT THIS IS NOT. This is a plain consumer WhatsApp deep link. There is no
// Meta Business API, no approved template, no outbound queue, no webhook, no
// `WA_*` env var, and nothing is stored about the send. The admin taps the
// button, WhatsApp opens with the message prefilled, and the admin presses
// send. See the plan's "Out of scope" section.

/** The absolute URL a staff member opens: `<appUrl>/invite/<rawToken>`. */
export function buildInviteUrl(appUrl: string, rawToken: string): string {
  return `${appUrl.replace(/\/+$/, '')}/invite/${rawToken}`;
}

/**
 * The prefilled WhatsApp body.
 *
 * FIRST NAME ONLY, deliberately. A WhatsApp message opening with a full legal
 * name reads automated and gets ignored; `Hi Ramesh` reads like a person. If a
 * name has no space (a single token) the whole thing is used.
 *
 * The org name is included because a staff member may be invited by more than
 * one business, and an unattributed link is indistinguishable from phishing.
 */
export function buildInviteMessage(params: {
  name: string;
  organizationName: string;
  inviteUrl: string;
}): string {
  const firstName = params.name.trim().split(/\s+/)[0] ?? params.name.trim();
  return [
    `Hi ${firstName}, you've been invited to join ${params.organizationName} on our CRM.`,
    '',
    `Set up your account here: ${params.inviteUrl}`,
  ].join('\n');
}

/**
 * `https://wa.me/<digits>?text=<encoded>`.
 *
 * `https://` rather than `whatsapp://` on purpose: the https form also works
 * from a desktop browser (it hands off to WhatsApp Web or prompts), whereas
 * the custom scheme only opens an installed app. An admin working from the
 * office is a real case.
 *
 * The phone is stripped to digits defensively even though the stored form is
 * already digits-only. A future field-level change that reintroduces a `+`
 * would otherwise produce a silently-broken link - the failure mode this
 * function exists to prevent.
 */
export function buildWhatsappUrl(phone: string, messageText: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(messageText)}`;
}

/** Convenience: everything the create/resend response carries. */
export interface InviteLinks {
  inviteUrl: string;
  whatsappUrl: string;
  messageText: string;
}

export function buildInviteLinks(params: {
  appUrl: string;
  rawToken: string;
  phone: string;
  name: string;
  organizationName: string;
}): InviteLinks {
  const inviteUrl = buildInviteUrl(params.appUrl, params.rawToken);
  const messageText = buildInviteMessage({
    name: params.name,
    organizationName: params.organizationName,
    inviteUrl,
  });
  return {
    inviteUrl,
    whatsappUrl: buildWhatsappUrl(params.phone, messageText),
    messageText,
  };
}
