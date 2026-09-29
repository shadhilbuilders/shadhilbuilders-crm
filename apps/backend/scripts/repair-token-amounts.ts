/**
 * One-off: bookings marked TOKEN with no token amount recorded (T-TOKEN-GATE).
 *
 * WHY THESE ROWS EXIST. `PATCH /api/bookings/:id` (HOLD -> TOKEN) used to set
 * `status = 'TOKEN'` and never read or wrote `tokenAmount`; the transition DTO
 * had no such field at all. So every booking advanced that way was recorded as
 * "token received" with no record of how much. The write path is fixed; these are
 * the rows it already produced.
 *
 * WHY THIS CANNOT SELF-REPAIR. The amount actually received is NOT derivable from
 * the database:
 *   - there is no payment/token/transaction model in the schema (verified), so
 *     nothing else holds the figure;
 *   - `Booking.tokenAmount` is null on these rows by definition, and the
 *     `booking.create` audit row does not capture tokenAmount either (it records
 *     only leadId/unitId/amount/status);
 *   - the `booking.transition` audit row records only the status pair.
 * The only source is outside the system - the bank entry / receipt - which is
 * exactly why the repair takes an operator-supplied value instead of inventing
 * one. Filling it with a placeholder (0, the booking amount, anything) would make
 * the data LOOK complete and be wrong, corrupting the admin "Booking money" card
 * in the opposite direction: it would report a token paid that never was.
 *
 * SAFETY. This touches money, so:
 *   - DRY RUN BY DEFAULT. Writes require --apply.
 *   - Read-only unless --apply is passed; nothing is ever inferred.
 *   - Only `tokenAmount` is written. NOT `status` - and that matters more than it
 *     looks: `BookingsService.syncLeadState` derives the LEAD's state from ALL of
 *     its bookings' statuses (APPROVED->WON, TOKEN->BOOKING_INITIATED, ...), so
 *     changing a status here could move a lead. Setting an amount cannot.
 *   - Refuses to touch any row whose status is not exactly TOKEN.
 *   - Re-verifies the row is still broken (and unchanged in status) immediately
 *     before writing, inside a transaction, so a concurrent transition cannot be
 *     clobbered.
 *   - Writes an AuditLog row per repair, recording before/after, so the change is
 *     attributable and reversible rather than an anonymous UPDATE.
 *
 * USAGE (from the repo root; DATABASE_URL must point at the target database - the
 * DIRECT/owner URL, since this is a maintenance task, not an app request):
 *
 *   # 1. See the damage. Read-only, no risk.
 *   npx tsx scripts/repair-token-amounts.ts
 *
 *   # 2. Repair ONE booking, having confirmed the amount against the record.
 *   npx tsx scripts/repair-token-amounts.ts --apply \
 *     --booking <bookingId> --amount 500000 --actor <operatorUserId> --reason "bank ref 1234"
 *
 *   # 3. Or repair many, each with its own amount (amounts are per booking -
 *   #    never one figure applied across rows).
 *   npx tsx scripts/repair-token-amounts.ts --apply --from-file amounts.json
 *   #    amounts.json: [{ "bookingId": "...", "amount": 500000, "reason": "ref 1234" }]
 *
 * `--actor` is REQUIRED for a write: the AuditLog insert needs a real user (the
 * `auditlog_insert_any_authenticated` policy requires a non-null app.user_id),
 * and an unattributed money change is not acceptable.
 */
import { readFileSync } from 'node:fs';

import { prisma } from '@shadhil/database';

/** A booking is broken when it claims a token but records no amount. */
const BROKEN = { status: 'TOKEN', amountMissing: true } as const;

/**
 * THE READ TRAP THIS GUARD EXISTS FOR.
 *
 * The app connects through the non-owner `shadhil_app` role, which is subject to
 * RLS. Row-level policies are keyed on `app.user_id` / `app.user_org_id`, and
 * this script deliberately does NOT set them (it is a maintenance task across the
 * whole organization, not a request from one user). Without those GUCs, RLS
 * filters the rows away entirely.
 *
 * The failure mode is therefore SILENT AND REASSURING: the script would print
 * "None. Every token-received booking records how much was received." while the
 * defect is untouched. A clean bill of health is the worst possible output for a
 * repair tool, so we verify we can actually see rows before trusting any result.
 *
 * We assert on the TOTAL booking count rather than the broken subset: "some
 * bookings are visible" is the property that makes an empty broken-set
 * meaningful, and it holds even on a database with no defects.
 */
async function assertCanSeeData(): Promise<void> {
  const total = await prisma.booking.count();
  if (total > 0) {
    console.log(`(connection can see ${total} booking row(s) - results are trustworthy)`);
    return;
  }
  throw new Error(
    [
      'Refusing to report: this connection cannot see ANY booking rows.',
      '',
      'That almost always means DATABASE_URL points at the non-owner `shadhil_app`',
      'role, whose RLS policies require `app.user_id` / `app.user_org_id` to be set.',
      'This script does not set them (it is not a user request), so an empty result',
      'here would be a lie rather than a clean bill of health.',
      '',
      'Re-run with the DIRECT (owner) connection, which bypasses RLS:',
      '  DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/repair-token-amounts.ts',
    ].join('\n'),
  );
}


type BrokenRow = {
  id: string;
  status: string;
  tokenAmount: string | null;
  amount: string;
  leadId: string;
  organizationId: string;
  leadName: string | null;
  unitNumber: string | null;
};

type Repair = { bookingId: string; amount: number; reason?: string };

function parseArgs(argv: string[]): {
  apply: boolean;
  booking?: string;
  amount?: number;
  actor?: string;
  reason?: string;
  fromFile?: string;
} {
  const out: {
    apply: boolean;
    booking?: string;
    amount?: number;
    actor?: string;
    reason?: string;
    fromFile?: string;
  } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--booking') out.booking = argv[++i];
    else if (arg === '--amount') out.amount = Number(argv[++i]);
    else if (arg === '--actor') out.actor = argv[++i];
    else if (arg === '--reason') out.reason = argv[++i];
    else if (arg === '--from-file') out.fromFile = argv[++i];
  }
  return out;
}

/** Read-only: every TOKEN booking with no positive amount recorded. */
async function findBroken(): Promise<BrokenRow[]> {
  const rows = await prisma.booking.findMany({
    where: { status: BROKEN.status },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      tokenAmount: true,
      amount: true,
      leadId: true,
      organizationId: true,
      lead: { select: { name: true } },
      unit: { select: { unitNumber: true } },
    },
  });
  return rows
    // The same "no amount" test the dashboard uses, so the script and the card
    // agree on which rows are broken. `<= 0` counts: 0 is not a received token.
    .filter((r) => r.tokenAmount === null || Number(r.tokenAmount) <= 0)
    .map((r) => ({
      id: r.id,
      status: r.status,
      tokenAmount: r.tokenAmount === null ? null : r.tokenAmount.toString(),
      amount: r.amount.toString(),
      leadId: r.leadId,
      organizationId: r.organizationId,
      leadName: r.lead?.name ?? null,
      unitNumber: r.unit?.unitNumber ?? null,
    }));
}

async function report(): Promise<BrokenRow[]> {
  await assertCanSeeData();
  const broken = await findBroken();
  console.log('');
  console.log('Bookings marked TOKEN with NO amount recorded (T-TOKEN-GATE)');
  console.log('-----------------------------------------------------------');
  if (broken.length === 0) {
    console.log('None. Every token-received booking records how much was received.');
    console.log('');
    return broken;
  }
  console.log(`${broken.length} row(s). The amount received is NOT in the database:`);
  console.log('no payment table exists and the audit rows do not carry it, so each');
  console.log('figure must come from the bank entry / receipt.\n');
  for (const r of broken) {
    const unit = r.unitNumber === null ? '-' : `Unit ${r.unitNumber}`;
    const lead = r.leadName ?? r.leadId;
    console.log(`  ${r.id}`);
    console.log(`    ${unit} · ${lead} · booking ${r.amount} · tokenAmount=${String(r.tokenAmount)}`);
  }
  console.log('');
  console.log('To repair one:');
  console.log(
    '  npx tsx scripts/repair-token-amounts.ts --apply --booking <id> --amount <received> --actor <userId>',
  );
  console.log('');
  return broken;
}

/**
 * Repair ONE booking. Re-reads the row inside the transaction and refuses if it
 * is no longer in the expected state, so a concurrent transition or a second run
 * cannot overwrite a real value.
 */
async function repairOne(
  repair: Repair,
  actor: string,
  fallbackReason: string | undefined,
): Promise<'repaired' | 'skipped-not-broken' | 'skipped-wrong-status'> {
  if (!Number.isFinite(repair.amount) || repair.amount <= 0) {
    throw new Error(`Refusing: amount must be a positive number (got ${repair.amount})`);
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.booking.findUnique({
      where: { id: repair.bookingId },
      // `amount` is read so the token cap can be checked HERE rather than left to
      // the "booking_token_within_total" CHECK constraint (migration
      // 20260929140000). The constraint is what actually protects the data, but
      // without this comparison an operator who mistypes a figure gets a raw
      // `violates check constraint "booking_token_within_total"` instead of a
      // sentence telling them the token cannot exceed the total.
      select: { id: true, status: true, tokenAmount: true, amount: true, organizationId: true },
    });
    if (current === null) {
      throw new Error(`Refusing: booking ${repair.bookingId} not found`);
    }
    const bookingTotal = Number(current.amount);
    if (Number.isFinite(bookingTotal) && repair.amount > bookingTotal) {
      throw new Error(
        `Refusing: ${repair.amount} exceeds this booking's total (${bookingTotal}). ` +
          'A token is a PART payment, so it can never be more than the booking total. ' +
          'Check the figure against the payment record - one of the two numbers is wrong.',
      );
    }
    if (current.status !== 'TOKEN') {
      // Guard against repairing a booking that has since moved on - and, more
      // importantly, against this script ever being repurposed to change a
      // status, which would drag the parent lead with it.
      return 'skipped-wrong-status' as const;
    }
    if (current.tokenAmount !== null && Number(current.tokenAmount) > 0) {
      // Someone already fixed it (or it was never broken). Never overwrite a
      // recorded amount with a guess.
      return 'skipped-not-broken' as const;
    }

    await tx.booking.update({
      where: { id: repair.bookingId },
      data: { tokenAmount: repair.amount.toFixed(2) },
    });
    // Money changes must be attributable. Mirrors the service's audit shape
    // (action/entityType/before/after) so this is indistinguishable from any
    // other booked change when read back.
    await tx.auditLog.create({
      data: {
        userId: actor,
        organizationId: current.organizationId,
        action: 'booking.token_amount_repair',
        entityType: 'Booking',
        entityId: repair.bookingId,
        before: { tokenAmount: current.tokenAmount === null ? null : current.tokenAmount.toString() },
        after: { tokenAmount: repair.amount.toFixed(2) },
        reason:
          repair.reason ??
          fallbackReason ??
          'Token amount was missing on a booking marked as received; recorded from the payment record',
      },
    });
    return 'repaired' as const;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Always show the damage first, even on a write run - the operator should see
  // the state they are changing.
  await report();

  if (!args.apply) {
    console.log('DRY RUN - nothing was written. Re-run with --apply to repair.');
    console.log('');
    return;
  }
  if (args.actor === undefined || args.actor.trim().length === 0) {
    throw new Error(
      'Refusing to write without --actor <userId>: an unattributed change to money is not acceptable, and the audit policy requires a real user.',
    );
  }

  let repairs: Repair[];
  if (args.fromFile !== undefined) {
    const parsed: unknown = JSON.parse(readFileSync(args.fromFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--from-file must contain a JSON array');
    repairs = parsed as Repair[];
  } else if (args.booking !== undefined) {
    if (args.amount === undefined || Number.isNaN(args.amount)) {
      throw new Error('--amount is required with --booking');
    }
    repairs = [{ bookingId: args.booking, amount: args.amount, reason: args.reason }];
  } else {
    throw new Error('Nothing to do: pass --booking <id> --amount <n>, or --from-file <path>');
  }

  let repaired = 0;
  for (const repair of repairs) {
    const outcome = await repairOne(repair, args.actor, args.reason);
    console.log(`  ${repair.bookingId} -> ${outcome}`);
    if (outcome === 'repaired') repaired += 1;
  }

  console.log('');
  console.log(`Repaired ${repaired} of ${repairs.length} requested.`);
  const remaining = await findBroken();
  console.log(`Still broken: ${remaining.length}.`);
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
