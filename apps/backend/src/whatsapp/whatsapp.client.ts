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
// 1. shadhil_chat_reply  (UTILITY, en)  ← env: WA_TEMPLATE_CHAT_REPLY
//    Category:  Utility (customer-initiated reply window - must be sent
//                within 24h of the lead's last inbound message)
//    Header:    none
//    Body:      "Hi {{1}}, {{2}}"
//    Buttons:   none
//    Sample:
//                Hi Aarav, thanks for the enquiry about the 3BHK
//                in Shadhil Meadows - let me know if you have any
//                questions.
//    Variables: {{1}} = lead first name (max 60 chars)
//                {{2}} = message body (max 1024 chars; chat service
//                         truncates to 1000)
//    When sent: chat service → outbound.send() with
//               templateName: 'shadhil_chat_reply', sendType: TEMPLATE
//
// 2. shadhil_visit_followup  (UTILITY, en)  ← env: WA_TEMPLATE_VISIT_FOLLOWUP
//    Category:  Utility (proactive - must respect 24h+ window after
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
// 3. shadhil_visit_reminder  (UTILITY, en)  ← env: WA_TEMPLATE_VISIT_REMINDER
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
//                {{2}} = datetime (formatted, max 60 chars - e.g.
//                         "Friday, 12 Sept at 10:00 AM")
//    When sent: reminder cron (T-E2b follow-up) → outbound.send() with
//               templateName: 'shadhil_visit_reminder', sendType: TEMPLATE
//               (scheduled 1-2h before the visit)
//
// Env-var name mapping (defaults to the template name itself):
//   WA_TEMPLATE_CHAT_REPLY            default 'shadhil_chat_reply'
//   WA_TEMPLATE_VISIT_FOLLOWUP        default 'shadhil_visit_followup'
//   WA_TEMPLATE_VISIT_REMINDER        default 'shadhil_visit_reminder'
//   WA_TEMPLATE_LANGUAGE              default 'en'
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
  /** Meta message ID (wamid.*) - used by the webhook to correlate
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

  /** Factory from env vars. Throws if any required var is missing -
   *  we want the failure to be loud at module init, not on first send.
   *
   *  Reads the `WA_*` names exclusively (no WHATSAPP_* aliases). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppClient {
    const accessToken = env.WA_ACCESS_TOKEN;
    const phoneNumberId = env.WA_PHONE_NUMBER_ID;
    const templateLanguage = env.WA_TEMPLATE_LANGUAGE ?? 'en';
    if (!accessToken) {
      throw new Error('WA_ACCESS_TOKEN not configured');
    }
    if (!phoneNumberId) {
      throw new Error('WA_PHONE_NUMBER_ID not configured');
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

  /**
   * Send a freeform text message via the WhatsApp Cloud API.
   *
   * Meta's customer-service window (24h after the customer's last inbound
   * message) allows plain text messages with NO template - a direct reply.
   * This is what chat sends use: the customer messaged us on WhatsApp, a
   * staff member replies within the window, so we can send raw text. Using
   * a template here (shadhil_chat_reply) is WRONG because (a) templates
   * cost money outside the free window and (b) the template must exist /
   * be approved in Meta, which fails with 132001 "template name does not
   * exist" otherwise - a freeform text reply avoids both entirely.
   *
   * @param to    recipient phone in E.164 (digits only, e.g. "919876543210")
   * @param text  the message body
   */
  async sendTextMessage(to: string, text: string): Promise<WhatsAppDelivery> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/messages`;

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
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
      throw new WhatsAppSendError(
        `WhatsApp API network error: ${errMsg(err)}`,
        null,
        'NetworkError',
        null,
      );
    }

    if (!res.ok) {
      const textResp = await res.text();
      throw new WhatsAppSendError(
        `WhatsApp API HTTP error ${res.status}: ${textResp}`,
        null,
        'HttpError',
        res.status,
      );
    }

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

  /**
   * Upload a media file to Meta's /media endpoint and return the media id
   * (media-id) that a media message can reference. Handles images,
   * documents (pdf/office), video, audio. Within the 24h customer-service
   * window these are free (same as text - a reply).
   *
   * Steps (per Meta Cloud API):
   *   1. POST /<PHONE_NUMBER_ID>/media with multipart form:
   *        messaging_product=whatsapp, type=<mime>, file=<bytes>
   *      → { id: "<media-id>" }
   *   2. The media-id is used in a message like:
   *        { type: "image", image: { id: mediaId } }
   * @returns the Meta media id (e.g. "1713510587238491")
   */
  async uploadMedia(
    file: { buffer: Buffer; mimeType: string; filename: string },
  ): Promise<string> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/media`;

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
      file.filename,
    );

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppSendError(
        `WhatsApp media upload HTTP error ${res.status}: ${text}`,
        null,
        'MediaUploadError',
        res.status,
      );
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new WhatsAppSendError(
        `WhatsApp media upload returned no id: ${JSON.stringify(data)}`,
        null,
        'MediaUploadError',
        null,
      );
    }
    this.logger.log(`[whatsapp] uploaded media id=${data.id}`);
    return data.id;
  }

  /**
   * Send a media message (image | document | video | audio) by media id.
   * The media-id is produced by `uploadMedia`. `caption`/`body` is an
   * optional text caption (images/documents support it).
   * Within the 24h window this is free.
   */
  async sendMediaMessage(
    to: string,
    media: {
      mediaId: string;
      type: 'image' | 'document' | 'video' | 'audio';
      caption?: string;
      filename?: string;
    },
  ): Promise<WhatsAppDelivery> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/messages`;
    const typeObj: Record<string, unknown> = { id: media.mediaId };
    if (media.caption !== undefined) typeObj.caption = media.caption;
    if (media.filename !== undefined) typeObj.filename = media.filename;

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: media.type,
      [media.type]: typeObj,
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

    const data = (await res.json()) as {
      messages?: Array<{
        id?: string;
        message_status?: string;
        errors?: Array<{ code?: number; title?: string }>;
      }>;
    };
    const message = data.messages?.[0];
    if (message?.message_status === 'failed') {
      return {
        wamid: message.id ?? null,
        accepted: false,
        errorCode: message.errors?.[0]?.code ?? null,
        errorTitle: message.errors?.[0]?.title ?? null,
      };
    }
    if (message?.id) this.logger.log(`[whatsapp] media accepted wamid=${message.id}`);
    return {
      wamid: message?.id ?? null,
      accepted: true,
      errorCode: null,
      errorTitle: null,
    };
  }

  /**
   * Resolve a Meta media id (from an inbound webhook message) to a
   * downloadable content URL. GET /<PHONE_NUMBER_ID>/media/<id> returns
   * `{ url }`. The URL points at Meta's CDN and can be fetched with a
   * Bearer header. Returns null if the media id is not retrievable.
   */
  async getMediaUrl(mediaId: string): Promise<string | null> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/media/${mediaId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      this.logger.warn(`[whatsapp] media lookup failed id=${mediaId} status=${res.status}`);
      return null;
    }
    const data = (await res.json()) as { url?: string };
    return data.url ?? null;
  }

  /**
   * Download the bytes for a Meta media id (inbound media, 2B). Returns
   * { buffer, mimeType } or null on any failure. The mimeType comes from
   * the media lookup response (Meta returns mime_type for documents).
   */
  async downloadMedia(
    mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
    const url = await this.getMediaUrl(mediaId);
    if (url === null) return null;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!res.ok) {
        this.logger.warn(`[whatsapp] media download failed id=${mediaId} status=${res.status}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
      // Meta's filename convention is <media-id>.<ext>; we keep the mime
      // so the storage layer can serve a sensible extension.
      const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'bin';
      return { buffer: buf, mimeType, filename: `${mediaId}.${ext}` };
    } catch (err) {
      this.logger.warn(`[whatsapp] media download failed id=${mediaId}: ${errMsg(err)}`);
      return null;
    }
  }
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
