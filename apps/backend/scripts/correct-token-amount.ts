/**
 * One-off: CORRECT a token amount that was recorded wrong (T-TOKEN-GATE).
 *
 * WHY THIS IS NOT `repair-token-amounts.ts`. That script fixes the OPPOSITE
 * defect - a booking marked "token received" with NO amount. Its guards are
 * deliberately narrow: it refuses any row whose status is not exactly TOKEN, and
 * refuses any row that already holds a positive amount, so it can never be used
 * to OVERWRITE money. Two rows in the wild need the other operation, a
 * CORRECTION, and both are blocked by those guards:
 *
 *   - an APPROVED booking (the repair script skips wrong-status), and
 *   - a row that already carries an amount, just the wrong one
 *     (the repair script skips not-broken).
 *
 * Weakening those guards would turn a safe tool into one that silently replaces
 * a recorded payment with an operator-typed number. So the correction lives here,
 * with its own guardrails, instead.
 *
 * HOW IT WRITES. It goes through `BookingsService.update()` - the SAME path the
 * booking Edit dialog uses - rather than a raw UPDATE. That matters: the service
 * re-applies the token cap (token must not exceed the booking total), the
 * clear-guard, the RLS context and the audit row. A raw UPDATE would bypass every
 * one of those, and the cap is exactly the rule these two rows violate.
 *
 * SAFETY
 *   - DRY RUN BY DEFAULT; writes require --apply.
 *   - `--actor` is REQUIRED (an unattributed change to money is unacceptable,
 *     and the audit policy needs a real user).
 *   - `--reason` is REQUIRED: a correction changes a payment figure, so it must
 *     carry the reference it was corrected FROM (bank entry / receipt).
 *   - Prints before/after for every row, and re-reads after the write.
 *   - NEVER invents an amount. There is no payment model in the schema, so the
 *     true figure exists only outside the system.
 *
 * USAGE (repo root; DATABASE_URL must be the owner/direct URL - this is a
 * maintenance task, not an app request, so RLS GUCs are not set):
 *
 *   # 1. See what is currently out of range. Read-only.
 *   DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/correct-token-amount.ts
 *
 *   # 2. Correct one booking (amount confirmed against the payment record).
 *   DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/correct-token-amount.ts \
 *     --apply --booking <bookingId> --amount 500000 --actor <operatorUserId> --reason "bank ref 1234"
 */
import { prisma } from '@shadhil/database';

// The service is imported for its VALIDATION, not its DI wiring: it is
// constructed with just the PrismaService it needs (notifications optional).
import { BookingsService } from '../src/bookings/bookings.service';

const OWNER_ORG = process.env['PUBLIC_ORG_ID'] ?? '';

/** A booking whose recorded token exceeds its own total - impossible by rule. */
async function findOutOfRange() {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      unit_number: string | null;
      status: string;
      amount: string;
      token_amount: string;
      lead_name: string | null;
    }>
  >(
    `SELECT b.id, u."unitNumber" AS unit_number, b.status::text AS status,
            b.amount::text AS amount, b."tokenAmount"::text AS token_amount,
            l.name AS lead_name
       FROM "Booking" b
       LEFT JOIN "Unit" u ON u.id = b."unitId"
       LEFT JOIN "Lead" l ON l.id = b."leadId"
      WHERE b."tokenAmount" IS NOT NULL AND b."tokenAmount" > b.amount
      ORDER BY (b."tokenAmount" - b.amount) DESC`,
  );
  return rows;
}

function parseArgs(argv: string[]) {
  const out: {
    apply: boolean;
    booking?: string;
    amount?: number;
    actor?: string;
    reason?: string;
  } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--booking') out.booking = argv[++i];
    else if (a === '--amount') out.amount = Number(argv[++i]);
    else if (a === '--actor') out.actor = argv[++i];
    else if (a === '--reason') out.reason = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // TRUST CHECK: the app role's RLS policies need app.user_id/app.user_org_id,
  // which this script deliberately does not set, so a non-owner connection sees
  // NOTHING and would report a reassuring "no problems found" while the defect
  // sits untouched. Prove we can see rows before trusting any result.
  const total = await prisma.booking.count();
  if (total === 0) {
    throw new Error(
      'Refusing to report: this connection sees 0 bookings, so an empty result ' +
        'would be a lie. Re-run with DATABASE_URL="$DIRECT_DATABASE_URL" (owner role).',
    );
  }
  console.log(`(connection sees ${total} booking row(s) - results are trustworthy)`);
  console.log('');

  const bad = await findOutOfRange();
  if (bad.length === 0) {
    console.log('None. No booking records a token larger than its own total.');
    return;
  }
  console.log(`Out of range: ${bad.length} booking(s) with token > total:`);
  for (const r of bad) {
    const over = (Number(r.token_amount) - Number(r.amount)).toFixed(2);
    console.log(
      `  ${r.id}  ${r.unit_number ?? '?'}  ${r.status.padEnd(9)} ` +
        `total ${r.amount}  token ${r.token_amount}  over by ${over}  (${r.lead_name ?? '?'})`,
    );
  }
  console.log('');

  if (!args.apply) {
    console.log('DRY RUN - nothing written. Correct one with:');
    console.log(
      '  DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/correct-token-amount.ts \\',
    );
    console.log(
      '    --apply --booking <id> --amount <received> --actor <userId> --reason "<bank ref>"',
    );
    console.log('');
    return;
  }

  if (args.booking === undefined) throw new Error('--booking is required with --apply');
  if (args.amount === undefined || !Number.isFinite(args.amount) || args.amount <= 0) {
    throw new Error('--amount must be a positive number');
  }
  if (args.actor === undefined || args.actor.trim().length === 0) {
    throw new Error('Refusing to write without --actor <userId>: an unattributed money change is not acceptable.');
  }
  if (args.reason === undefined || args.reason.trim().length === 0) {
    throw new Error('Refusing to write without --reason: record the reference the corrected figure came from.');
  }

  const actorRow = await prisma.user.findUnique({
    where: { id: args.actor },
    select: { id: true, role: true, organizationId: true, email: true },
  });
  if (actorRow === null) throw new Error(`--actor ${args.actor} is not a user`);

  const before = await prisma.booking.findUnique({
    where: { id: args.booking },
    select: { id: true, status: true, amount: true, tokenAmount: true, organizationId: true },
  });
  if (before === null) throw new Error(`booking ${args.booking} not found`);
  console.log(
    `before: status=${before.status} total=${String(before.amount)} token=${String(before.tokenAmount)}`,
  );

  // Through the SERVICE: re-applies the token cap, the clear-guard, and writes
  // the audit row, all inside one RLS-scoped transaction.
  const service = new BookingsService({ $client: prisma } as never);
  await service.update(
    {
      sub: actorRow.id,
      email: actorRow.email,
      role: actorRow.role,
      organizationId: actorRow.organizationId || OWNER_ORG || before.organizationId,
      iat: 0,
      exp: 0,
      iss: 'shadhil-crm',
    } as never,
    args.booking,
    // The reason MUST travel with the write: the service puts it on the audit
    // row, and this is the only record of which bank entry/receipt the corrected
    // figure came from. (Dropping it here would silently fall back to the
    // generated "updated by <email>" string - which is exactly the
    // unattributable money change this script exists to avoid.)
    { tokenAmount: args.amount, reason: args.reason } as never,
  );

  const after = await prisma.booking.findUnique({
    where: { id: args.booking },
    select: { status: true, amount: true, tokenAmount: true },
  });
  console.log(
    `after:  status=${after?.status} total=${String(after?.amount)} token=${String(after?.tokenAmount)}`,
  );
  console.log(`reason recorded: ${args.reason}`);
  console.log('');
  const remaining = await findOutOfRange();
  console.log(`Still out of range: ${remaining.length}.`);
  console.log('');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('');
    console.error(err instanceof Error ? err.message : String(err));
    console.error('');
    await prisma.$disconnect();
    process.exit(1);
  });
