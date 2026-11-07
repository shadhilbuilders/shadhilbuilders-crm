// PushService.sendToUsers (issue #8 slice 2).
//
// protects= one recipient's failure never stops the others, duplicates are
//           delivered once, and the call never throws.
// fails_when= a throwing recipient aborts the loop, a user is pushed twice,
//           or an error escapes to the caller (the upload path).
// no_claim= does NOT exercise web-push or the DB; sendAs is spied.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@shadhil/database', () => ({ rlsContextFrom: vi.fn(), withRlsContext: vi.fn() }));

import { PushService } from './push.service';

describe('PushService.sendToUsers', () => {
  it('isolates a failing recipient, dedupes ids, and returns the attempted count', async () => {
    const svc = new PushService({ $client: {} } as never);
    const sendAs = vi
      .spyOn(svc as unknown as { sendAs: (...a: unknown[]) => Promise<number> }, 'sendAs')
      .mockImplementation(async (userId: unknown) => {
        if (userId === 'bad') throw new Error('boom');
        return 2;
      });
    const n = await svc.sendToUsers('org-1', ['u1', 'bad', 'u1', 'u2'], { title: 't', body: 'b' });
    expect(sendAs).toHaveBeenCalledTimes(3); // u1 once, bad, u2
    expect(n).toBe(4); // u1 (2) + u2 (2); the failure contributes 0
  });
});
