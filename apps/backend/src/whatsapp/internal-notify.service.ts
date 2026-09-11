// Internal WhatsApp notifications - sends an approved template to a fixed
// ops/test recipient (not a lead).
//
// This is the "internal ops alerting" path (e.g. `internal_enquiry_notification`
// to the ops team's WhatsApp) vs. the lead-chat outbound path (OutboundMessage
// outbox, which is lead-keyed and drains via the 5s cron). Internal notify:
//   - reads the recipient + template from env (`WHATSAPP_RECIPIENT_1`,
//     `WHATSAPP_INTERNAL_TEMPLATE_NAME`)
//   - uses the same WhatsAppClient.sendTemplateMessage (graph.facebook.com)
//   - delivers synchronously (for the smoke-test trigger) and records a
//     WebhookEvent-free audit line via the logger; it does NOT write an
//     OutboundMessage row (those are lead-bound via the FK to Message).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { WHATSAPP_RECIPIENT_1, WHATSAPP_INTERNAL_TEMPLATE_NAME } from './internal-notify.config';
import { WhatsAppClient, WhatsAppSendError } from './whatsapp.client';

export type InternalNotifyResult = {
  sent: boolean;
  wamid: string | null;
  recipient: string;
  template: string;
  error: string | null;
};

@Injectable()
export class InternalNotifyService {
  private readonly logger = new Logger(InternalNotifyService.name);

  constructor(
    @Inject(WhatsAppClient) private readonly whatsapp: WhatsAppClient,
  ) {}

  /**
   * Send the internal notification template to the configured recipient.
   * `parameters` are the {{1}}, {{2}} ... body values, in order. Returns the
   * delivery outcome; throws WhatsAppSendError on hard failure.
   */
  async send(
    parameters: Array<{ type: 'text'; text: string }> = [],
  ): Promise<InternalNotifyResult> {
    const recipient = WHATSAPP_RECIPIENT_1;
    const template = WHATSAPP_INTERNAL_TEMPLATE_NAME;
    if (!recipient) {
      throw new Error('WHATSAPP_RECIPIENT_1 not configured');
    }
    if (!template) {
      throw new Error('WHATSAPP_INTERNAL_TEMPLATE_NAME not configured');
    }
    try {
      const delivery = await this.whatsapp.sendTemplateMessage(
        recipient,
        template,
        parameters,
      );
      if (!delivery.accepted) {
        const error = `Meta refused: code=${
          delivery.errorCode ?? ''
        } title=${delivery.errorTitle ?? ''}`;
        this.logger.warn(`[whatsapp:internal] ${error}`);
        return {
          sent: false,
          wamid: delivery.wamid,
          recipient,
          template,
          error,
        };
      }
      this.logger.log(
        `[whatsapp:internal] sent wamid=${delivery.wamid} to ${recipient} (${template})`,
      );
      return {
        sent: true,
        wamid: delivery.wamid,
        recipient,
        template,
        error: null,
      };
    } catch (err) {
      const error =
        err instanceof WhatsAppSendError
          ? `${err.message}${err.code ? ` (code ${err.code})` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.error(`[whatsapp:internal] send failed: ${error}`);
      return { sent: false, wamid: null, recipient, template, error };
    }
  }

  /** Resolve template variable keys for the internal enquiry notification. */
  static enquiryParams(values: {
    name?: string;
    phone?: string;
    project?: string;
    message?: string;
  }): Array<{ type: 'text'; text: string }> {
    return [values.name, values.phone, values.project, values.message]
      .filter((v): v is string => typeof v === 'string')
      .map((text) => ({ type: 'text' as const, text }));
  }
}
