// PortalUnitRecord: what the buyer actually bought, and what they owe.
//
// WHY (2026-11-09): every one of these figures lives in the CRM, and until now
// a buyer had to phone the office to learn their own plot number or the price
// they had agreed. This panel puts the whole record on one screen.
//
// SOURCE OF TRUTH IS THE BOOKING, NOT THE UNIT, for money. `listAmount` is the
// baseline captured at booking time and `negotiatedAmount` / `finalAmount` are
// the terms agreed for THIS deal; the unit's `price` may have been edited
// since approval, so showing it would risk quoting a number nobody agreed to.
// The unit supplies the physical facts (plot, bhk, facing, built-up area).
//
// Everything is a label/value pair on hairlines, the same rhythm the hero's
// note column uses. Nothing is invented: a null field renders "Not recorded",
// never a guess and never a zero.
//
// LAYOUT (2026-11-09): unit and price sit SIDE BY SIDE from `sm` up, because
// they are two halves of one answer ("what did I buy" / "what do I owe") and
// stacking them left a tall single column with a lot of dead width beside it.
// They stack on phones, where two 160px columns would squeeze the values.
import { currencyIntl, formatBalanceDue, numberIntl } from '@/lib/format';
import type { PortalUnit } from '@/hooks/queries/customer-portal';

type Fact = { label: string; value: string; emphasis?: 'total' };

function Row({ label, value, emphasis }: Fact) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--portal-hair)] py-2 last:border-b-0">
      <dt className="shrink-0 text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase">
        {label}
      </dt>
      <dd
        className={
          'portal-figure text-right ' +
          (emphasis === 'total'
            ? 'text-[1.0625rem] font-medium text-[var(--portal-navy)]'
            : 'text-[0.8125rem] text-[var(--portal-navy)]')
        }
      >
        {value}
      </dd>
    </div>
  );
}

/** The eyebrow + display line that heads each half of the record. */
function BlockHead({
  id,
  eyebrow,
  display,
}: {
  id?: string;
  eyebrow: string;
  display: string;
}) {
  return (
    <>
      <h2 id={id} className="portal-eyebrow mb-1.5">
        {eyebrow}
      </h2>
      <p className="portal-display mb-3 text-[1.25rem] leading-[1.32] text-[var(--portal-navy)]">
        {display}
      </p>
    </>
  );
}

const NOT_RECORDED = 'Not recorded';

export function PortalUnitRecord({ unit }: { unit: PortalUnit }) {
  const plot = unit.plotNumber === null ? NOT_RECORDED : String(unit.plotNumber);
  const facing = unit.facing === null || unit.facing.trim() === '' ? NOT_RECORDED : unit.facing;
  const plotSqft = unit.plotSqft === null ? NOT_RECORDED : `${numberIntl.format(unit.plotSqft)} sq.ft`;

  const physical: Fact[] = [
    { label: 'Plot number', value: plot },
    { label: 'BHK', value: `${unit.bhk} BHK` },
    { label: 'Facing', value: facing },
    { label: 'Plot sq.ft', value: plotSqft },
    { label: 'Built-up sq.ft', value: `${numberIntl.format(Number(unit.buildupSqft))} sq.ft` },
    { label: 'Phase', value: unit.phaseName ?? NOT_RECORDED },
    { label: 'Project', value: unit.projectName },
  ];

  const money: Fact[] = [
    { label: 'Per sq.ft', value: currencyIntl.format(Number(unit.pricePerSqft)) },
    { label: 'List total', value: currencyIntl.format(Number(unit.listAmount)) },
  ];
  if (unit.isNegotiated) {
    if (unit.negotiatedRate !== null) {
      money.push({ label: 'Negotiated rate', value: currencyIntl.format(Number(unit.negotiatedRate)) });
    }
    if (unit.negotiatedAmount !== null) {
      money.push({ label: 'Negotiated', value: currencyIntl.format(Number(unit.negotiatedAmount)) });
    }
    // The "You pay" row only earns its place when it DIFFERS from the list
    // total (2026-11-09). With no negotiation it would repeat the headline
    // figure twice on one screen - the display line above already says it.
    money.push({ label: 'You pay', value: currencyIntl.format(Number(unit.finalAmount)), emphasis: 'total' });
  }

  // Token already received. Only shown when staff recorded one - an unrecorded
  // token is not a zero payment, and printing "₹0 paid" would imply the buyer
  // has paid nothing when the office simply has not entered it.
  if (unit.tokenAmount !== null) {
    money.push({ label: 'Token paid', value: currencyIntl.format(Number(unit.tokenAmount)) });
  }

  // What is still owed. "Balance due" is the number a buyer actually acts on,
  // so it closes the block and carries the weight. `formatBalanceDue` treats an
  // unrecorded token as 0 and never returns a negative - a buyer who overpaid
  // reads ₹0 due rather than a negative balance.
  const balanceDue = formatBalanceDue(unit.finalAmount, unit.tokenAmount);
  money.push({ label: 'Balance due', value: balanceDue, emphasis: 'total' });

  return (
    <section aria-labelledby="portal-unit-record-title" data-qa="portal-unit-record">
      {/* Two halves of one answer, side by side from sm. On a phone they stack;
          `sm:border-l` is dropped there so no rule dangles at a column edge. */}
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 sm:gap-10 lg:gap-14">
        <div className="border-t-2 border-[var(--portal-navy)] pt-4">
          <BlockHead id="portal-unit-record-title" eyebrow="Your unit" display={unit.unitNumber} />
          <dl data-qa="portal-unit-record-physical">
            {physical.map((f) => (
              <Row key={f.label} {...f} />
            ))}
          </dl>
        </div>

        <div className="border-t-2 border-[var(--portal-navy)] pt-4">
          {/* The headline is what is STILL OWED, not the total. A buyer opening
              this screen wants the number they must act on; repeating the total
              here when nothing was negotiated (finalAmount === listAmount) said
              the same figure twice before the breakdown. `balanceDue` also
              drives the copy below, so the two can never disagree. */}
          <BlockHead eyebrow="Price" display={balanceDue} />
          <dl data-qa="portal-unit-record-price">
            {money.map((f) => (
              <Row key={f.label} {...f} />
            ))}
          </dl>
          {unit.isNegotiated ? (
            <p className="mt-3 text-[0.6875rem] leading-relaxed text-[var(--portal-ink-2)]">
              Agreed with your sales contact and approved with your booking.
            </p>
          ) : (
            <p className="mt-3 text-[0.6875rem] leading-relaxed text-[var(--portal-ink-2)]">
              List price. Any agreed discount will appear here once approved.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
