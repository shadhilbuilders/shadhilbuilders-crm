// UnitSwitcher (issue #8 slice 2, design D4): one chip per unit, rendered
// ONLY when the buyer has more than one. A single unit means no control at
// all - a lone chip is noise that implies a choice that does not exist.
//
// REDESIGN (2026-11-09, second pass): the selected chip is no longer a filled
// rounded pill. On a page of rules and hairlines it now reads as a tab on a
// paper index: navy text, a green underline, no fill. That keeps the page's one
// green accent meaning "current".
import type { PortalUnit } from '@/hooks/queries/customer-portal';

export function UnitSwitcher({
  units,
  selectedUnitId,
  onSelect,
}: {
  units: readonly PortalUnit[];
  selectedUnitId: string | null;
  onSelect: (unitId: string) => void;
}) {
  if (units.length < 2) return null;
  return (
    <div
      role="group"
      aria-label="Choose a unit"
      data-qa="unit-switcher"
      className="portal-snap-x -mx-4 flex gap-1 overflow-x-auto border-b border-[var(--portal-hair)] px-4 sm:mx-0 sm:flex-wrap sm:px-0"
    >
      {units.map((unit) => {
        const selected = unit.unitId === selectedUnitId;
        return (
          <button
            key={unit.unitId}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(unit.unitId)}
            data-qa="unit-switcher-chip"
            className={
              'relative min-h-11 shrink-0 px-3 text-[0.9375rem] font-medium transition-colors duration-300 ' +
              (selected
                ? 'text-[var(--portal-navy)]'
                : 'text-[var(--portal-ink-2)] hover:text-[var(--portal-navy)]')
            }
          >
            {unit.unitNumber}
            <span className="ml-2 text-sm font-normal opacity-70">{unit.projectName}</span>
            {selected ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--portal-green)]"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
