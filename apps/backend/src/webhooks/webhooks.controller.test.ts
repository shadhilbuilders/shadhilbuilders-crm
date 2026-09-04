// Webhooks controller test — T-WEBHOOK (2026-09-07).
//
// Verifies the basic WA Business payload shape is accepted and
// returns 202 with the stubbed response. The full WhatsApp Business
// API integration (signature verification, dedup, lead creation,
// outbound reply) ships in Week 7 — see the TODO in webhooks.module.ts.

import { describe, expect, it } from 'vitest';

import { WebhooksController } from './webhooks.controller';

describe('WhatsApp inbound webhook — T-WEBHOOK 202-stub', () => {
  const controller = new WebhooksController();

  it('accepts the slimmed WA payload shape and returns a queued ack', () => {
    const result = controller.whatsappInbound({
      from: '919876543210',
      body: 'hi',
      messageId: 'wamid.123',
    });
    expect(result).toEqual({
      received: true,
      messageId: 'wamid.123',
      status: 'queued',
    });
  });

  it('rejects payloads missing messageId', () => {
    expect(() =>
      controller.whatsappInbound({
        from: '919876543210',
        body: 'hi',
        // no messageId
      }),
    ).toThrow(/messageId/);
  });

  it('rejects non-object payloads', () => {
    expect(() => controller.whatsappInbound('not-an-object')).toThrow();
    expect(() => controller.whatsappInbound(null)).toThrow();
  });

  it('Meta verification handshake still works (unchanged from Phase 1)', () => {
    // Sanity check that the GET endpoint is intact — we don't want
    // a T-WEBHOOK edit to break the existing Meta handshake.
    process.env.WA_WEBHOOK_VERIFY_TOKEN = 'test-token';
    const challenge = controller.verify('subscribe', 'test-token', 'CHALLENGE_123');
    expect(challenge).toBe('CHALLENGE_123');
    delete process.env.WA_WEBHOOK_VERIFY_TOKEN;
  });
});
