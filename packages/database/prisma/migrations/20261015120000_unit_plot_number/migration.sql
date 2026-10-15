-- T-PLOT-LINK (2026-10-15): the CMDA plot number becomes a FIELD on the unit.
--
-- WHY: the plot map used to read a unit as a plot when its unit NUMBER was a
-- bare integer ("37" = plot 37, see the old parsePlotNumber). That conflates two
-- different identifiers. The unit number is the DOOR number on the villa
-- ("A-101"); the plot number is the villa's position on the approved drawing.
-- With door numbers in use no unit was ever read as a plot, so every plot on
-- the map read available and the panel could not link to a real record.
--
-- Additive and nullable on purpose: existing units keep working. They start at
-- NULL and are simply not on a layout until someone assigns a plot number.
ALTER TABLE "Unit" ADD COLUMN "plotNumber" INTEGER;

-- One plot number per phase. Postgres treats NULLs as distinct, so any number of
-- unassigned units coexist. Two phases of one project may each hold plot 5, and
-- `plots()` resolves that conflict by the most binding claim, exactly as it
-- already did for a duplicated unit number.
CREATE UNIQUE INDEX "Unit_phaseId_plotNumber_key" ON "Unit"("phaseId", "plotNumber");

-- No new GRANTs: this is a column on a table the app role already holds
-- SELECT/INSERT/UPDATE/DELETE on (20260915060000_unit_status_sync section 6).
