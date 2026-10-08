// Schema contract for the unit/negotiated pricing migration
// (20261009020000_unit_buildup_negotiated_booking). Reads information_schema
// through the OWNER role so it asserts what the migration actually produced on
// the live DB: no NULLs allowed on the strict columns (the backfill left none
// behind), the negotiated columns are optional, and the legacy token CHECK was
// re-added after the backfill dropped it for a moment.
import { afterAll, describe, expect, it } from 'vitest';

import { createDirectPrismaClient } from '../src/test-db-isolation';

const OWNER = createDirectPrismaClient();
type Raw = { $queryRawUnsafe: <T>(q: string, ...a: unknown[]) => Promise<T> };
const raw = OWNER as unknown as Raw;

afterAll(async () => {
  await (OWNER as unknown as { $disconnect: () => Promise<void> }).$disconnect();
});

async function nullable(table: string, column: string): Promise<string | undefined> {
  const rows = await raw.$queryRawUnsafe<Array<{ is_nullable: string }>>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    table,
    column,
  );
  return rows[0]?.is_nullable;
}

describe('unit + negotiated booking pricing columns', () => {
  it.each([
    ['Unit', 'buildupSqft'],
    ['Unit', 'pricePerSqft'],
    ['Booking', 'listAmount'],
  ])('%s.%s is NOT NULL (strict model, backfilled)', async (table, column) => {
    expect(await nullable(table, column)).toBe('NO');
  });

  it.each([
    ['Booking', 'negotiatedRate'],
    ['Booking', 'negotiatedAmount'],
  ])('%s.%s is optional', async (table, column) => {
    expect(await nullable(table, column)).toBe('YES');
  });

  it('keeps booking_token_within_total after the backfill', async () => {
    const rows = await raw.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conname = 'booking_token_within_total'`,
    );
    expect(rows).toHaveLength(1);
  });
});
