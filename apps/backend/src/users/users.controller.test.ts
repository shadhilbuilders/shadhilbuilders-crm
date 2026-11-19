// Users controller - DTO validation error contract (regression test).
//
// Pins the bug fixed 2026-09-13: `PATCH /api/users/:id/manager` called
// `AssignManagerDtoSchema.parse(body)` directly, so a malformed body threw a
// raw ZodError that NestJS's ExceptionsHandler rendered as an opaque
// 500 "Internal server error". The other write routes on this controller
// already used the local `parseBody()` helper, which converts ZodError into a
// 400 BadRequestException carrying readable field-level messages.
//
// This test calls the controller method directly (no HTTP layer) and asserts
// the thrown exception type + message shape, mirroring
// teams.controller's parseBody contract. It fails if anyone reverts the route
// to a bare `.parse()`.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { UsersController } from './users.controller';
import type { UsersService } from './users.service';

type Actor = { sub: string; role: 'ADMIN'; organizationId: string; email: string };

function makeController() {
  const assignManager = vi.fn().mockResolvedValue({ id: 'exec-1' });
  const service = { assignManager } as unknown as UsersService;
  const controller = new UsersController(service);
  const req = {
    user: {
      sub: 'admin-1',
      role: 'ADMIN',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      email: 'admin@x',
    } as unknown as Actor,
  };
  return { controller, assignManager, req };
}

describe('UsersController.assignManager - body validation', () => {
  it('a non-cuid2 teamId yields 400 BadRequestException (NOT a raw ZodError → 500)', async () => {
    const { controller, assignManager, req } = makeController();

    // Hyphenated slug-style id - the shape test fixtures used to generate,
    // and exactly what the web UI sent when the bug was reported.
    const body = { teamId: 'test-detail-teamB-1789277517952-5tyequ' };

    const err = await controller
      .assignManager(req as never, 'exec-1', body)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    // The message is a readable per-field list, not a stack trace.
    const response = (err as BadRequestException).getResponse();
    expect(JSON.stringify(response)).toContain('teamId');
    // The service must never be reached with an invalid DTO.
    expect(assignManager).not.toHaveBeenCalled();
  });

  it('a missing teamId yields 400 with a readable message', async () => {
    const { controller, assignManager, req } = makeController();

    const err = await controller
      .assignManager(req as never, 'exec-1', {})
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(assignManager).not.toHaveBeenCalled();
  });

  it('a valid cuid2 teamId reaches the service', async () => {
    const { controller, assignManager, req } = makeController();

    await controller.assignManager(req as never, 'exec-1', {
      teamId: 'far14c9rpe877pnz8ymayx57',
    });

    expect(assignManager).toHaveBeenCalledWith(req.user, 'exec-1', {
      teamId: 'far14c9rpe877pnz8ymayx57',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/users?includePhone=true - the query param must reach the service.
//
// Regression (fixed 2026-11-19): `parseFilter` rebuilds the filter field by
// field and never copied `includePhone`, so the flag was accepted by the DTO
// and dropped. The service therefore always omitted `phone`, and the admin
// Users table - the one surface that asks for it - rendered an em dash in the
// phone column and opened its edit dialog with an empty phone field, while the
// value sat in the database.
// ---------------------------------------------------------------------------

describe('UsersController.list - filter parsing', () => {
  function makeListController() {
    const list = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const controller = new UsersController({ list } as unknown as UsersService);
    const req = {
      user: {
        sub: 'admin-1',
        role: 'ADMIN',
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        email: 'admin@x',
      } as unknown as Actor,
    };
    return { controller, list, req };
  }

  it('?includePhone=true reaches the service as `true`', async () => {
    const { controller, list, req } = makeListController();

    await controller.list(req as never, { includePhone: 'true', limit: '10' });

    expect(list).toHaveBeenCalledTimes(1);
    const filter = list.mock.calls[0]?.[1] as { includePhone?: boolean; limit?: number };
    expect(filter.includePhone).toBe(true);
    expect(filter.limit).toBe(10);
  });

  it('an absent or non-"true" flag stays undefined, so pickers stay PII-free', async () => {
    for (const query of [{}, { includePhone: 'false' }, { includePhone: '1' }]) {
      const { controller, list, req } = makeListController();
      await controller.list(req as never, query);
      const filter = list.mock.calls[0]?.[1] as { includePhone?: boolean };
      expect(filter.includePhone, JSON.stringify(query)).toBeUndefined();
    }
  });
});
