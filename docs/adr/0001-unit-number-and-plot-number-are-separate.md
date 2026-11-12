# ADR-0001: Unit number and plot number are separate identifiers

**Date**: 2026-10-15, recorded 2026-11-07 from the schema and migration rationale
**Status**: accepted
**Deciders**: not recorded; delivered under ticket T-PLOT-LINK

## Context

A villa carries two identifiers that look interchangeable and are not. The unit number is the door number painted on the building, like A-101, which is what sales names and quotes. The plot number is the villa's position on the CMDA-approved layout, and the plot map needs it to place the villa on the drawing and to link the drawing back to a real record.

Until October 2026 the map had no plot number to work with, so it inferred one. `parsePlotNumber` treated a unit as a plot whenever its unit number happened to be a bare integer, reading "37" as plot 37. That held only while unit numbers were integers. Once door numbers came into use, no unit parsed as a plot, so every plot on the map rendered as available and the panel could not link to a real unit.

## Decision

`Unit.plotNumber` is its own nullable integer column, distinct from `Unit.unitNumber`. Nothing derives one from the other, and the plot map joins on `plotNumber` alone. `parsePlotNumber` is gone.

## Alternatives Considered

### Keep inferring the plot from the unit number

- **Pros**: no schema change, no backfill, nothing to keep in sync.
- **Cons**: correctness depended on the shape of a marketing string. Any project that numbered its doors properly lost its entire map.
- **Why not**: it was already broken by the time door numbers shipped.

### Use a single identifier for both

- **Pros**: one number to print, quote, and draw.
- **Cons**: the two numbers come from different authorities. The door number is the company's own naming; the plot number is fixed by the approved layout. A project with no traced layout has no plot numbers at all.
- **Why not**: one field would either block projects that have no layout, or put a drawing position onto a door sign.

## Consequences

### Positive

- A project with no traced layout can exist, and its units simply carry no plot number.
- The map reads a column instead of parsing a string, so renaming a door number cannot empty the map.
- Both numbers stay quotable to the right audience: sales by door number, the site team by plot number.

### Negative

- Two fields to maintain, and a unit without a plot number sits off the layout until someone assigns one.
- Putting a new unit onto a traced layout is a second step that can be forgotten.

### Risks

- A project may be traced only after its units exist, leaving every plot number NULL. Mitigation: the column is nullable by design, and the map must read NULL as "not on the layout", never as available.
- A later backfill that derives plot numbers from unit numbers would restore the original conflation. That is why GLOSSARY.md lists each term as the other's _Avoid_.
