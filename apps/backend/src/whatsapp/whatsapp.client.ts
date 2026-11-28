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
// templates below cover T-E2b's outbound paths:
//
// 1. shadhil_enquiry_reply  (UTILITY, en)  ← env: WA_TEMPLATE_CHAT_REPLY
//    Replaced `shadhil_chat_reply` on 2026-11-24, which is still live as
//    MARKETING because Meta refuses to recategorise an approved template
//    (3835031). Rows still carrying the old name resolve through
//    RETIRED_TEMPLATE_NAMES in outbound.service.ts.
//    Header:    none
//    Body:      "Hello {{1}}, this is a reply from Shadhil Builders about your
//                enquiry. {{2}} Reply here if you have any questions."
//    Buttons:   none
//    Sample:    Hello Aarav, this is a reply from Shadhil Builders about your
//               enquiry. The 2BHK at Green Court is free from March. Reply here
//               if you have any questions.
//    Variables: {{1}} = lead first name (max 60 chars)
//               {{2}} = the reply text (max 1024 chars; the chat service
//                        truncates to 1000)
//    When sent: only OUTSIDE the 24h window. Inside it the chat service sends a
//               FREEFORM reply, which needs no template at all.
//
// 2. shadhil_site_visit_checkin  (UTILITY, en)  ← env: WA_TEMPLATE_VISIT_FOLLOWUP
//    Replaced `shadhil_site_visit_followup` on the same day, same reason. The
//    old copy asked "are you still interested", which is a sales nudge under
//    any label; this one asks how the visit went and offers a call back.
//    Header:    TEXT, "Site Visit Follow Up"
//    Body:      "Hello {{1}}, this is a follow up to your site visit for
//                {{2}}. Reply here with how the visit went, or reply CALL and
//                the site team will ring you back."
//    Variables: {{1}} = lead first name (max 60 chars)
//               {{2}} = project name (max 60 chars)
//    When sent: nothing yet. The outbox whitelists the name; no caller enqueues
//               it, so approving it added no behaviour.
//
// 3. shadhil_visit_reminder_v2  (UTILITY, en)  ← env: WA_TEMPLATE_VISIT_REMINDER
//    Category:  Utility (proactive reminder for an upcoming visit)
//    Header:    none
//    Footer:    "Shadhil Builders & Constructions"
//    Body:      "Your site visit for *{{1}}* is on {{2}}.\n\n
//                Just reply YES to confirm, or RESCHEDULE if you need a
//                different time."
//    Buttons:   none - and do not add any. A quick-reply button arrives as a
//               `button` message, not text, and the reply parser only reads
//               text bodies, so buttons would silently break the confirmation.
//    Sample:
//                Your site visit for Shadhil Meadows is on
//                Friday, 12 September at 10:00 AM. Just reply YES to confirm,
//                or RESCHEDULE if you need a different time.
//    Variables: {{1}} = project name (max 60 chars)
//                {{2}} = datetime (formatted, max 60 chars - e.g.
//                         "Friday, 12 September at 10:00 AM")
//    When sent: nothing yet (2026-11-28). The reminder cron notifies STAFF only;
//               no caller enqueues this template, so a customer never receives
//               it. Wire the sender before treating this copy as live.
//    Why _v2: the approved `shadhil_visit_reminder` said "Reply YES and our team
//               will confirm". The webhook now confirms on the customer's word,
//               and Meta refuses to edit an approved template (2388039 - "you
//               can only delete or add templates"), so the corrected copy is a
//               new name and the old one was deleted.
//
// 4. shadhil_villa_update_video  (UTILITY, en)  ← env: WA_TEMPLATE_SITE_UPDATE_VIDEO
// 5. shadhil_villa_update_image  (UTILITY, en)  ← env: WA_TEMPLATE_SITE_UPDATE_IMAGE
//    Replaced `shadhil_site_update_video` and `shadhil_site_update_image` on
//    2026-11-24. Those two were approved as MARKETING on 2026-11-23 despite a
//    UTILITY submission, which billed every outside-window send, spent a
//    per-recipient marketing allowance, and made the buyer's MARKETING consent a
//    precondition. The replacements were approved as UTILITY the day they were
//    submitted and delivered their first message at 12:21:58Z that day.
//    What still gates the send is a recorded "no" (2026-11-27): the consent
//    panel is the stop switch, and a skip now reads SKIPPED_OPTED_OUT rather
//    than a missing opt-in. A buyer nobody has asked still gets the update.
//    Header:    VIDEO (4) / IMAGE (5) - the ONLY difference between the two,
//                because Meta fixes a header type at approval and one name
//                cannot serve both a clip and its poster.
//    Body:      "Hello {{1}}, a site progress update has been recorded for villa
//                {{2}}. {{3}} Open the record for this booking to see the stage
//                and the photos filed with it."
//    Footer:    Shadhil Builders
//    Buttons:   one URL button, dynamic: /portal?photo={{1}}
//    Sample:
//                Hello Asha, a site progress update has been recorded for villa
//                A-101 (plot 37). Plinth poured, curing until Friday. Open the
//                record for this booking to see the stage and the photos filed
//                with it.
//    Variables: {{1}} body = customer first name, or "there" when the stored
//                         name is unusable (a title, a phone number, initials)
//                {{2}} body = villa and plot, e.g. "A-101 (plot 37)"
//                {{3}} body = the engineer's note, or one neutral line when
//                         they wrote none (a generated caption is never quoted)
//                {{1}} button = the saved row id, so the portal opens THIS update
//    When sent: site-update-delivery.service.ts after the row commits, outside
//               the 24h window only; inside it the freeform path is used.
//
// Env-var name mapping (defaults to the template name itself):
//   WA_TEMPLATE_CHAT_REPLY            default 'shadhil_enquiry_reply'
//   WA_TEMPLATE_VISIT_FOLLOWUP        default 'shadhil_site_visit_checkin'
//   WA_TEMPLATE_VISIT_REMINDER        default 'shadhil_visit_reminder_v2'
//   WA_TEMPLATE_SITE_UPDATE_VIDEO     default 'shadhil_villa_update_video'
//   WA_TEMPLATE_SITE_UPDATE_IMAGE     default 'shadhil_villa_update_image'
//   WA_TEMPLATE_LANGUAGE              default 'en'
//
// Test-mode override: Meta allows you to send any approved template
// to numbers on the test allowlist (your own + the test numbers
// added in App Dashboard → WhatsApp → API Setup). Until a real
// business is approved and onboarded, add your test phone there
// and use the env var overrides to point at the test-template-name
// you have approved.
// ────────────────────────────────────────────────────────────────────

import { parsePhone } from '@shadhil/api-types';
import { Injectable, Logger } from '@nestjs/common';

const GRAPH_API_VERSION = 'v26.0';

export interface TemplateParameter {
  type: 'text';
  text: string;
}

/**
 * A template header parameter. Documents were the only kind until the site
 * update needed one: Meta takes a PUBLIC link it fetches itself, so a video
 * header must be a short-lived signed URL (`StorageProvider.shareUrl`), never
 * the authenticated BFF path.
 */
export type TemplateHeaderComponent =
  | {
      type: 'header';
      parameters: Array<{ type: 'document'; document: { link: string; filename: string } }>;
    }
  | {
      type: 'header';
      parameters: Array<{ type: 'video'; video: { link: string } }>;
    }
  | {
      type: 'header';
      parameters: Array<{ type: 'image'; image: { link: string } }>;
    };

/**
 * A URL-button parameter. Meta's template button carries at most one variable,
 * and it must be the LAST thing in the URL, so the approved template is
 * `https://host/portal?photo={{1}}` and the send supplies only the id.
 *
 * `index` is the button's position in the template as a STRING ("0" for the
 * first), because that is what Meta's API takes.
 */
export interface TemplateButtonComponent {
  type: 'button';
  sub_type: 'url';
  index: string;
  parameters: Array<{ type: 'text'; text: string }>;
}

/** Outcome of one send. `accepted=false` is a soft failure: the
 *  HTTP request succeeded but Meta refused the message. Throw at
 *  the call site to mark the OutboundMessage as FAILED. */
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

/** One approved (or submitted) template, as Meta returns it.
 *
 *  Read live from the WABA that owns the sending number: Meta resolves a
 *  template inside that WABA, so a body read from anywhere else (a code
 *  comment, a plan doc, another business account) is not evidence of what
 *  customers receive. */
export interface WhatsAppTemplateSummary {
  /** Meta's template id. Editing and deleting address the template by this. */
  id: string;
  name: string;
  /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED ... */
  status: string;
  /** UTILITY | MARKETING | AUTHENTICATION */
  category: string;
  language: string;
  header: { format: string; text: string | null } | null;
  body: string | null;
  footer: string | null;
  buttonLabels: string[];
}

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
    button?: TemplateButtonComponent,
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
    // The button's variable goes in its own component, AFTER the body. Meta
    // matches components by type, so this order is the documented one.
    if (button) components.push(button as unknown as Record<string, unknown>);

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
   * Read every template on a WhatsApp Business Account.
   *
   * T-WA-VISIT-REPLY (2026-11-28): copy advice was being given from the comment
   * block above, which describes what someone submitted months ago. Meta is the
   * only authority on what is approved today, and a template resolves inside the
   * WABA that owns the SENDING number - so the WABA comes from config
   * (`WA_BUSINESS_ACCOUNT_ID`), never from memory.
   *
   * Read-only, and it lives here rather than in a script because this class is
   * the only thing in the repo that holds the access token.
   */
  async listTemplates(wabaId: string): Promise<WhatsAppTemplateSummary[]> {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates` +
      '?fields=id,name,status,category,language,components&limit=100';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WhatsApp template list failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        status?: string;
        category?: string;
        language?: string;
        components?: Array<{
          type?: string;
          format?: string;
          text?: string;
          buttons?: Array<{ text?: string }>;
        }>;
      }>;
    };
    return (data.data ?? []).map((row) => {
      const components = row.components ?? [];
      const find = (type: string) => components.find((c) => c.type === type) ?? null;
      const header = find('HEADER');
      const body = find('BODY');
      const footer = find('FOOTER');
      const buttons = find('BUTTONS');
      return {
        id: row.id ?? '',
        name: row.name ?? '',
        status: row.status ?? 'UNKNOWN',
        category: row.category ?? 'UNKNOWN',
        language: row.language ?? '',
        header: header === null ? null : { format: header.format ?? '', text: header.text ?? null },
        body: body?.text ?? null,
        footer: footer?.text ?? null,
        buttonLabels: (buttons?.buttons ?? []).map((b) => b.text ?? '').filter((t) => t !== ''),
      };
    });
  }

  /**
   * Replace an approved template's BODY and send it back to Meta's review.
   *
   * T-WA-VISIT-REPLY (2026-11-28): the visit reminder's copy promised "our team
   * will confirm" for a reply that the webhook now acts on itself, so the copy
   * had to follow the behaviour. Editing an approved template moves its status
   * to PENDING until review finishes, and a PENDING template cannot be sent.
   *
   * Operator tool, not a send-path call: nothing in the request flow edits
   * templates.
   */
  async updateTemplateBody(templateId: string, body: string): Promise<void> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${templateId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ components: [{ type: 'BODY', text: body }] }),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp template update failed ${res.status}: ${await res.text()}`);
    }
  }

  /**
   * Create a template on the business account.
   *
   * Meta refuses to edit an approved template ("Message template status can't be
   * changed. You can only delete or add templates." - 2388039), so a copy fix is
   * a new name plus a deletion of the old one. That is why this exists next to
   * `updateTemplateBody`, which only works on templates still under review.
   *
   * The status comes back PENDING and review takes minutes to a day; a PENDING
   * template cannot be sent.
   */
  async createTemplate(
    wabaId: string,
    input: {
      name: string;
      category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
      body: string;
      /** One example value per {{N}}, in order. Required when the body has vars. */
      exampleParams: string[];
      footer?: string;
      language?: string;
    },
  ): Promise<{ id: string; status: string }> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`;
    const components: Array<Record<string, unknown>> = [
      {
        type: 'BODY',
        text: input.body,
        ...(input.exampleParams.length > 0
          ? { example: { body_text: [input.exampleParams] } }
          : {}),
      },
    ];
    if (input.footer !== undefined) components.push({ type: 'FOOTER', text: input.footer });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        language: input.language ?? this.templateLanguage,
        category: input.category,
        parameter_format: 'POSITIONAL',
        components,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`WhatsApp template create failed ${res.status}: ${text}`);
    const data = JSON.parse(text) as { id?: string; status?: string };
    return { id: data.id ?? '', status: data.status ?? 'UNKNOWN' };
  }

  /**
   * Delete a template from the business account.
   *
   * There is no undo: Meta does not restore a deleted template, and the name
   * cannot be reused for a while afterwards. Only call it for a template the
   * repo can prove has no sender - check the code first, not the name.
   */
  async deleteTemplate(wabaId: string, name: string): Promise<void> {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates` +
      `?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`WhatsApp template delete failed ${res.status}: ${await res.text()}`);
    }
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
  async uploadMedia(file: { buffer: Buffer; mimeType: string; filename: string }): Promise<string> {
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

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
