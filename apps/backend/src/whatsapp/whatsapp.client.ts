// T-E2b: Meta WhatsApp Cloud API client.
//
// Mirrors the patterns from `landing-page/lib/whatsapp.ts` (the
// production-tested implementation) adapted to the shadhil-crm
// stack: NestJS + Prisma + workspace-local types. Key behaviors
// ported verbatim:
//
//   - GRAPH_API_VERSION = "v26.0" (current Meta API version; bump
//     here when landing page bumps)
//   - toE164() normalizes raw phone input to digits-only (no "+")
//   - sendTemplateMessage() handles Meta's "HTTP 200 with
//     message_status: 'failed' in the body" edge case (codes 131026,
//     131030, etc.) and throws a descriptive Error
//
// Difference from landing page: this client is NestJS-injectable
// (constructor takes the env once, exposes `send()`) rather than a
// module of free functions. Makes testing cleaner (mock the
// `WhatsAppClient` in Nest tests).
//
// Server-side only. All credentials come from env vars; nothing is
// hardcoded and nothing is exposed to the client.
//
// ────────────────────────────────────────────────────────────────────
// Meta template submissions (paste into Meta Business Suite
// → WhatsApp Manager → Message Templates → Create template)
// ────────────────────────────────────────────────────────────────────
// The cron (outbound.cron.ts) calls sendTemplateMessage for every
// PENDING OutboundMessage. Meta requires each template to be
// submitted and approved before any business can send it. The
// three templates below cover T-E2b's outbound paths:
//
// 1. shadhil_chat_reply  (UTILITY, en)  ← env: WHATSAPP_TEMPLATE_CHAT_REPLY
//    Category:  Utility (customer-initiated reply window — must be sent
//                within 24h of the lead's last inbound message)
//    Header:    none
//    Body:      "Hi {{1}}, {{2}}"
//    Buttons:   none
//    Sample:
//                Hi Aarav, thanks for the enquiry about the 3BHK
//                in Shadhil Meadows — let me know if you have any
//                questions.
//    Variables: {{1}} = lead first name (max 60 chars)
//                {{2}} = message body (max 1024 chars; chat service
//                         truncates to 1000)
//    When sent: chat service → outbound.send() with
//               templateName: 'shadhil_chat_reply', sendType: TEMPLATE
//
// 2. shadhil_visit_followup  (UTILITY, en)  ← env: WHATSAPP_TEMPLATE_VISIT_FOLLOWUP
//    Category:  Utility (proactive — must respect 24h+ window after
//                last inbound; this is for follow-ups to leads whose
//                last inbound was > 24h ago)
//    Header:    none
//    Body:      "Hi {{1}}, just following up on your site visit for {{2}}.
//                Are you still interested? Reply YES to chat."
//    Buttons:   none
//    Sample:
//                Hi Priya, just following up on your site visit for
//                Shadhil Meadows. Are you still interested? Reply YES
//                to chat.
//    Variables: {{1}} = lead first name (max 60 chars)
//                {{2}} = project name (max 60 chars)
//    When sent: visit → site-visit service → outbound.send() with
//               templateName: 'shadhil_visit_followup', sendType: TEMPLATE
//               (scheduled 24-48h after the site visit)
//
// 3. shadhil_visit_reminder  (UTILITY, en)  ← env: WHATSAPP_TEMPLATE_VISIT_REMINDER
//    Category:  Utility (proactive reminder for upcoming visit)
//    Header:    none
//    Body:      "Your site visit for {{1}} is on {{2}}. Reply YES
//                to confirm or RESCHEDULE."
//    Buttons:   none
//    Sample:
//                Your site visit for Shadhil Meadows is on
//                Friday, 12 Sept at 10:00 AM. Reply YES to confirm
//                or RESCHEDULE.
//    Variables: {{1}} = project name (max 60 chars)
//                {{2}} = datetime (formatted, max 60 chars — e.g.
//                         "Friday, 12 Sept at 10:00 AM")
//    When sent: reminder cron (T-E2b follow-up) → outbound.send() with
//               templateName: 'shadhil_visit_reminder', sendType: TEMPLATE
//               (scheduled 1-2h before the visit)
//
// Env-var name mapping (defaults to the template name itself):
//   WHATSAPP_TEMPLATE_CHAT_REPLY       default 'shadhil_chat_reply'
//   WHATSAPP_TEMPLATE_VISIT_FOLLOWUP   default 'shadhil_visit_followup'
//   WHATSAPP_TEMPLATE_VISIT_REMINDER   default 'shadhil_visit_reminder'
//   WHATSAPP_TEMPLATE_LANGUAGE         default 'en'
//
// Test-mode override: Meta allows you to send any approved template
// to numbers on the test allowlist (your own + the test numbers
// added in App Dashboard → WhatsApp → API Setup). Until a real
// business is approved and onboarded, add your test phone there
// and use the env var overrides to point at the test-template-name
// you have approved.
// ────────────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';

const GRAPH_API_VERSION = 'v26.0';

export interface TemplateParameter {
  type: 'text';
  text: string;
}

export interface TemplateHeaderComponent {
  type: 'header';
  parameters: Array<{ type: 'document'; document: { link: string; filename: string } }>;
}

export interface WhatsAppDelivery {
  /** Meta message ID (wamid.*) — used by the webhook to correlate
   *  status callbacks back to our outbox row. */
  wamid: string | null;
  /** True iff Meta accepted the message for delivery. False when
   *  Meta returned 200 with message_status: 'failed' in the body. */
  accepted: boolean;
  /** Error code + title when accepted=false, e.g. 131030 / "Recipient
   *  phone number not in allowed list". */
  errorCode: number | null;
  errorTitle: string | null;
}

/** Normalize a raw phone number to E.164 (digits only, no +). */
export function toE164(raw: string): string {
  // Strip spaces, dashes, parentheses, dots
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  return digits;
}

/** Outcome of one send. `accepted=false` is a soft failure: the
 *  HTTP request succeeded but Meta refused the message. Throw at
 *  the call site to mark the OutboundMessage as FAILED. */
export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly title: string | null,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly templateLanguage: string,
  ) {}

  /** Factory from env vars. Throws if any required var is missing —
   *  we want the failure to be loud at module init, not on first send. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppClient {
    const accessToken = env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
    const templateLanguage = env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en';
    if (!accessToken) {
      throw new Error('WHATSAPP_ACCESS_TOKEN not configured');
    }
    if (!phoneNumberId) {
      throw new Error('WHATSAPP_PHONE_NUMBER_ID not configured');
    }
    return new WhatsAppClient(accessToken, phoneNumberId, templateLanguage);
  }

  /**
   * Send a template message via the WhatsApp Cloud API.
   *
   * @param to             recipient phone in E.164 (digits only, e.g. "919876543210")
   * @param templateName   approved Meta template name
   * @param parameters     ordered {{1}}, {{2}}, ... body parameter values
   * @param header         optional header component (e.g. document for brochure PDF)
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    parameters: TemplateParameter[],
    header?: TemplateHeaderComponent,
  ): Promise<WhatsAppDelivery> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/messages`;

    const components: Array<Record<string, unknown>> = [];
    if (header) {
      components.push(header as unknown as Record<string, unknown>);
    }
    components.push({
      type: 'body',
      parameters,
    });

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: this.templateLanguage },
        components,
      },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network failure (DNS, connection refused, etc.)
      throw new WhatsAppSendError(
        `WhatsApp API network error: ${errMsg(err)}`,
        null,
        'NetworkError',
        null,
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppSendError(
        `WhatsApp API HTTP error ${res.status}: ${text}`,
        null,
        'HttpError',
        res.status,
      );
    }

    // Meta can return HTTP 200 with message_status "failed" inside the
    // body (e.g. 131026 undeliverable, 131030 recipient not on the
    // test allowlist). Treat those as failures instead of reporting a
    // false "sent".
    const data = (await res.json()) as {
      messages?: Array<{
        id?: string;
        message_status?: string;
        errors?: Array<{ code?: number; title?: string }>;
      }>;
    };
    const message = data.messages?.[0];

    if (message?.message_status === 'failed') {
      const code = message.errors?.[0]?.code ?? null;
      const title = message.errors?.[0]?.title ?? null;
      return {
        wamid: message.id ?? null,
        accepted: false,
        errorCode: code,
        errorTitle: title,
      };
    }

    if (message?.id) {
      this.logger.log(`[whatsapp] accepted wamid=${message.id}`);
    }
    return {
      wamid: message?.id ?? null,
      accepted: true,
      errorCode: null,
      errorTitle: null,
    };
  }
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
