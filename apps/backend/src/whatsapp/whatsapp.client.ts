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
