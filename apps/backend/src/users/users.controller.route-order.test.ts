// PATCH /api/users/me - self-service profile edit (settings page, 2026-09-18).
//
// Two contracts are pinned here, both of which have already bitten this
// codebase in other modules:
//
//   1. ROUTE ORDER. NestJS matches routes in DECLARATION order. `@Patch('me')`
//      must be declared BEFORE `@Patch(':id')`, or a literal `me` is captured
//      by the `:id` param and this route silently becomes unreachable. The
//      same trap is already documented on GET `team` and
//      GET `project/:projectId/sales-execs`, where the fix was ordering.
//      tsc and eslint cannot see this - only an explicit assertion can.
//
//   2. BODY VALIDATION. A malformed body must produce a 400 BadRequestException
//      with readable field messages, NOT a raw ZodError that Nest's exception
//      handler renders as an opaque 500. This mirrors the identical regression
//      test written for PATCH /:id/manager (users.controller.test.ts), which
//      was a real bug fixed 2026-09-13.
//
// Calls the controller methods directly - no HTTP layer - so the assertions
// fail at the source of the mistake rather than at some transport detail.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { UsersController } from './users.controller';
import type { UsersService } from './users.service';

type Actor = {
  sub: string;
  role: 'TELECALLER';
  organizationId: string;
  email: string;
};

const ACTOR: Actor = {
  sub: 'iruidos281826frk3qq7q4h0',
  role: 'TELECALLER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  email: 'tele@x',
};

function makeController() {
  const updateSelf = vi.fn().mockResolvedValue({
    id: ACTOR.sub,
    name: 'Renamed',
    email: ACTOR.email,
    role: 'TELECALLER',
  });
  const service = { updateSelf } as unknown as UsersService;
  const controller = new UsersController(service);
  return { controller, updateSelf };
}

describe('UsersController.updateMe - route order', () => {
  it('@Patch("me") is declared BEFORE @Patch(":id"), or `me` is captured as an id', () => {
    // Reflect the HTTP path metadata Nest reads at registration time. This is
    // the same data the router builds its match table from, so asserting on
    // ordering here is asserting on the real dispatch order.
    const proto = UsersController.prototype as unknown as Record<string, unknown>;
    const declarations = Object.getOwnPropertyNames(proto)
      .map((name) => {
        const handler = proto[name];
        if (typeof handler !== 'function') return null;
        const path = Reflect.getMetadata('path', handler) as unknown;
        const method = Reflect.getMetadata('method', handler) as unknown;
        if (typeof path !== 'string' || method === undefined) return null;
        return { name, path };
      })
      .filter((entry): entry is { name: string; path: string } => entry !== null);

    const meIndex = declarations.findIndex((d) => d.path === 'me' && d.name === 'updateMe');
    const idIndex = declarations.findIndex((d) => d.path === ':id' && d.name === 'update');

    expect(meIndex).toBeGreaterThanOrEqual(0);
    expect(idIndex).toBeGreaterThanOrEqual(0);
    // Strictly before: equal would mean one shadowed the other.
    expect(meIndex).toBeLessThan(idIndex);
  });
});

describe('UsersController.updateMe - body validation', () => {
  it('a non-string name yields 400 BadRequestException (NOT a raw ZodError -> 500)', async () => {
    const { controller, updateSelf } = makeController();

    const err = await controller
      .updateMe({ user: ACTOR } as never, { name: 12345 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((err as BadRequestException).getResponse())).toContain('name');
    // The service must never be reached with an invalid DTO.
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('an empty-after-trim name yields 400', async () => {
    const { controller, updateSelf } = makeController();

    const err = await controller
      .updateMe({ user: ACTOR } as never, { name: '   ' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('email is NOT an accepted field - a self-edit cannot move the login address', async () => {
    const { controller, updateSelf } = makeController();

    // The DTO is z.object({ name }) - zod strips unknown keys rather than
    // throwing, so the contract to pin is "email never reaches the service".
    await controller.updateMe({ user: ACTOR } as never, {
      name: 'Renamed',
      email: 'attacker@example.com',
    });

    expect(updateSelf).toHaveBeenCalledTimes(1);
    const [, dto] = updateSelf.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(dto).toEqual({ name: 'Renamed' });
    expect(dto).not.toHaveProperty('email');
  });

  it('the target is the JWT subject - the route exposes no id parameter', async () => {
    const { controller, updateSelf } = makeController();

    await controller.updateMe({ user: ACTOR } as never, { name: 'Renamed' });

    const [actor] = updateSelf.mock.calls[0] as [{ sub: string }];
    expect(actor.sub).toBe(ACTOR.sub);
    // updateMe takes exactly (req, body). A third parameter would be a route
    // param, i.e. a way to address someone else's row.
    expect(UsersController.prototype.updateMe.length).toBe(2);
  });
});
