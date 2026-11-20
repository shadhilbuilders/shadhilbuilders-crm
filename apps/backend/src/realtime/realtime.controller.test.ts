// Realtime ticket controller - body validation contract.
//
// `mint` used to hand-roll a typeof check on `body.channel` while the shared
// MintTicketDtoSchema (api-types) sat unused in the import. The hand-rolled
// version accepted a 500-character channel and anything else the per-channel
// dispatch in the service did not happen to reject, so the two definitions of
// "valid channel" could drift. It now parses with the schema.
//
// Called directly, no HTTP layer: this asserts the thrown exception type and
// that the parsed value is what reaches the service.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { RealtimeTicketController } from './realtime.module';
import type { RealtimeService } from './realtime.service';

function makeController() {
  const mintTicket = vi.fn().mockResolvedValue({ ticket: 't-1', expiresIn: 60 });
  const service = { mintTicket } as unknown as RealtimeService;
  const controller = new RealtimeTicketController(service);
  const req = {
    user: { sub: 'user-1', role: 'ADMIN', organizationId: 'org-1', email: 'a@x' },
  } as unknown as AuthedRequest;
  return { controller, mintTicket, req };
}

describe('RealtimeTicketController.mint', () => {
  it('rejects a missing channel with a 400, not a 500', async () => {
    const { controller, mintTicket, req } = makeController();

    await expect(controller.mint(req, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(mintTicket).not.toHaveBeenCalled();
  });

  it('rejects an empty channel', async () => {
    const { controller, mintTicket, req } = makeController();

    await expect(controller.mint(req, { channel: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mintTicket).not.toHaveBeenCalled();
  });

  it('rejects a channel past the schema limit', async () => {
    const { controller, mintTicket, req } = makeController();

    await expect(controller.mint(req, { channel: 'x'.repeat(121) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mintTicket).not.toHaveBeenCalled();
  });

  it('rejects a non-string channel', async () => {
    const { controller, mintTicket, req } = makeController();

    await expect(controller.mint(req, { channel: 42 as unknown as string })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mintTicket).not.toHaveBeenCalled();
  });

  it('passes the parsed channel to the service', async () => {
    const { controller, mintTicket, req } = makeController();

    await controller.mint(req, { channel: 'chat:lead-1' });

    expect(mintTicket).toHaveBeenCalledWith(req.user, { channel: 'chat:lead-1' });
  });
});
