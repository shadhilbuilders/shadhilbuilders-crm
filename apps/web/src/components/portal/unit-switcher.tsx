// UnitSwitcher (issue #8 slice 2, design D4): one chip per unit, rendered
// ONLY when the buyer has more than one. A single unit means no control at
// all - a lone chip is noise that implies a choice that does not exist.
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
    <div role="group" aria-label="Choose a unit" data-qa="unit-switcher" className="flex flex-wrap gap-2">
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
              'min-h-11 rounded-full border px-4 text-base font-medium ' +
              (selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-foreground')
            }
          >
            {unit.unitNumber}
            <span className="text-muted-foreground ml-2 text-sm font-normal">{unit.projectName}</span>
          </button>
        );
      })}
    </div>
  );
}
