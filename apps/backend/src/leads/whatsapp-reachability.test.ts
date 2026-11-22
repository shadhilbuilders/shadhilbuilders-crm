import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '@shadhil/database';

import {
  UNREACHABLE_DETAIL,
  deriveWhatsAppReachability,
  type WhatsAppReachability,
} from './whatsapp-reachability';

/**
 * The verdict decides whether the chat composer is disabled, so each branch is
 * pinned. There is no pre-flight lookup in the Cloud API: the only evidence is
 * a message from them, or Meta telling us the send failed.
 */
function fakeClient(options: {
  inbound: boolean;
  lastOutbound: { status: string; lastError: string | null } | null;
}): PrismaClient {
  return {
    message: {
      findFirst: async () => (options.inbound ? { id: 'm1' } : null),
    },
    outboundMessage: {
      findFirst: async () =>
        options.lastOutbound === null
          ? null
          : { ...options.lastOutbound, createdAt: new Date() },
    },
  } as unknown as PrismaClient;
}

async function verdict(options: Parameters<typeof fakeClient>[0]): Promise<WhatsAppReachability> {
  const result = await deriveWhatsAppReachability(fakeClient(options), 'lead-1');
  return result.state;
}

describe('deriveWhatsAppReachability', () => {
  it('is REACHABLE once they have written to us', async () => {
    expect(await verdict({ inbound: true, lastOutbound: null })).toBe('REACHABLE');
  });

  it('is UNKNOWN for a lead nobody has messaged', async () => {
    expect(await verdict({ inbound: false, lastOutbound: null })).toBe('UNKNOWN');
  });

  it('is UNREACHABLE when Meta reports 131026 and nothing came in after', async () => {
    const result = await deriveWhatsAppReachability(
      fakeClient({
        inbound: false,
        lastOutbound: {
          status: 'FAILED',
          lastError: '{"code":131026,"title":"Message undeliverable"}',
        },
      }),
      'lead-1',
    );
    expect(result.state).toBe('UNREACHABLE');
    expect(result.detail).toBe(UNREACHABLE_DETAIL);
  });

  it('does NOT read 131030 as unreachable - that is a test-mode allowlist', async () => {
    expect(
      await verdict({
        inbound: false,
        lastOutbound: {
          status: 'FAILED',
          lastError: '{"code":131030,"title":"Recipient not in allowed list"}',
        },
      }),
    ).toBe('UNKNOWN');
  });

  it('treats a delivered send as REACHABLE even with no inbound message', async () => {
    expect(
      await verdict({ inbound: false, lastOutbound: { status: 'DELIVERED', lastError: null } }),
    ).toBe('REACHABLE');
  });

  it('stays UNKNOWN for a failure that says nothing about WhatsApp', async () => {
    expect(
      await verdict({
        inbound: false,
        lastOutbound: { status: 'FAILED', lastError: '{"code":131047,"title":"Re-engagement"}' },
      }),
    ).toBe('UNKNOWN');
  });
});
