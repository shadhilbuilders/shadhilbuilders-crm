// InventoryController.list - the `search` param must reach the service.
//
// Regression guard for a silent-drop class of bug (T-INV-SEARCH, 2026-09-25):
// `list()` builds the DTO from a HAND-PICKED candidate object rather than
// passing the raw query through, so any field the DTO declares but the
// candidate omits is dropped without error - the grid renders the unfiltered
// set and the search box looks broken while returning 200. The same failure
// shape as a misnamed query param, which this repo has hit before
// (`limit` arriving as a string, and `filters that never reach the API`).
//
// Calls the controller method directly (no HTTP layer), mirroring
// users.controller.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { InventoryController } from './inventory.controller';
import type { InventoryService } from './inventory.service';

function makeController() {
  const list = vi.fn().mockResolvedValue({ total: 0, rows: [] });
  const service = { list } as unknown as InventoryService;
  const controller = new InventoryController(service);
  const req = {
    user: {
      sub: 'admin-1',
      role: 'ADMIN',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      email: 'admin@x',
    },
  };
  return { controller, list, req };
}

describe('InventoryController.list - search param', () => {
  it('forwards ?search= to the service DTO', async () => {
    const { controller, list, req } = makeController();

    await controller.list(req as never, { search: 'A-103' });

    expect(list).toHaveBeenCalledTimes(1);
    const dto = list.mock.calls[0]![1] as { search?: string };
    expect(dto.search).toBe('A-103');
  });

  it('omits search when the param is absent (no empty-string filter)', async () => {
    const { controller, list, req } = makeController();

    await controller.list(req as never, {});

    const dto = list.mock.calls[0]![1] as { search?: string };
    expect(dto.search).toBeUndefined();
  });

  it('survives alongside the other filters (search does not displace them)', async () => {
    const { controller, list, req } = makeController();

    await controller.list(req as never, {
      search: 'B-2',
      phaseId: 'oe6g1xkagiisnn4oeefpdyhk',
      bhk: '3',
      facing: 'South',
      status: 'AVAILABLE,HOLD',
      limit: '10',
      offset: '20',
    });

    const dto = list.mock.calls[0]![1] as Record<string, unknown>;
    // The whole filter set must land together - a search that worked only in
    // isolation would still be a bug on the grid, where filters combine.
    expect(dto).toMatchObject({
      search: 'B-2',
      phaseId: 'oe6g1xkagiisnn4oeefpdyhk',
      bhk: 3,
      facing: 'South',
      status: ['AVAILABLE', 'HOLD'],
      limit: 10,
      offset: 20,
    });
  });
});
