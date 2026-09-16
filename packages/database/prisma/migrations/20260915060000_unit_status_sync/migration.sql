-- T-INV-SYNC (2026-09-15): make Unit.status a pure function of the booking
-- lifecycle, and enforce one active booking per unit.
--
-- WHY (root cause of the inventory/bookings status drift):
--   1. Unit.status was a hand-maintained duplicate of Booking.status. The
--      only writer was bookings.service.ts calling `unit.update(...)` inside
--      a user-scoped RLS transaction. The Unit UPDATE policy
--      (unit_update_admin, migration 20260910000000_inventory_rls, org-gated
--      by 20260911190000_t_org_gate_feature_policies) allows ADMIN only, so
--      for MANAGER / SALES_EXEC / TELECALLER the write silently matched ZERO
--      rows - no error, no drift signal. The grid lied.
--   2. Every path that touched Booking outside that service (seed scripts,
--      demo fixtures) moved no unit status at all.
--   3. Nothing prevented several active bookings on one unit.
--
-- FIX: an AFTER trigger on Booking, running inside a SECURITY DEFINER
-- function, recomputes the parent Unit's status on every insert/update/delete.
-- Because the function is owned by the table owner (`shadhil`) it is not
-- subject to the caller's RLS visibility, so the sync now works identically
-- for every role and for scripts/crons. Unit.status becomes derived data;
-- application code must NOT write it (bookings.service.ts lost all four
-- direct unit.update calls in this change).
--
-- Mapping: APPROVED -> SOLD, else TOKEN -> TOKEN, else HOLD -> HOLD,
--          else AVAILABLE.  (Matches the previous service intent, and fixes
--          the missing TOKEN case: Unit.status=TOKEN was unreachable before.)
--
-- Trigger is plain AFTER INSERT OR UPDATE OR DELETE (no column list) so no
-- ORM-generated UPDATE shape can slip past it.

-- ── 1. Recompute helper ────────────────────────────────────────────────────
-- SECURITY DEFINER bypasses the Unit UPDATE policy for this derived write
-- only. search_path pinned so the definer's privileges can't be hijacked.
CREATE OR REPLACE FUNCTION unit_recompute_status(p_unit_id text)
RETURNS "UnitStatus"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v "UnitStatus";
BEGIN
  v := (CASE
    WHEN EXISTS (SELECT 1 FROM "Booking" b
                  WHERE b."unitId" = p_unit_id AND b.status = 'APPROVED') THEN 'SOLD'
    WHEN EXISTS (SELECT 1 FROM "Booking" b
                  WHERE b."unitId" = p_unit_id AND b.status = 'TOKEN')    THEN 'TOKEN'
    WHEN EXISTS (SELECT 1 FROM "Booking" b
                  WHERE b."unitId" = p_unit_id AND b.status = 'HOLD')     THEN 'HOLD'
    ELSE 'AVAILABLE'
  END)::"UnitStatus";

  UPDATE "Unit" SET status = v
   WHERE id = p_unit_id AND status IS DISTINCT FROM v;

  RETURN v;
END $$;

COMMENT ON FUNCTION unit_recompute_status(text) IS
  'T-INV-SYNC: derives Unit.status from its bookings (SOLD > TOKEN > HOLD > AVAILABLE). SECURITY DEFINER so the sync is role-independent.';

-- ── 2. Trigger ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION unit_status_sync() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    PERFORM unit_recompute_status(old."unitId");
    RETURN old;
  END IF;

  -- A booking re-pointed at another unit frees the old one.
  IF tg_op = 'UPDATE' AND old."unitId" IS DISTINCT FROM new."unitId" THEN
    PERFORM unit_recompute_status(old."unitId");
  END IF;

  PERFORM unit_recompute_status(new."unitId");
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS unit_status_sync_booking ON "Booking";
CREATE TRIGGER unit_status_sync_booking
  AFTER INSERT OR UPDATE OR DELETE ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION unit_status_sync();

-- ── 3. Repair: cancel duplicate active bookings ────────────────────────────
-- Keeps one active booking per unit: most advanced status wins
-- (APPROVED > TOKEN > HOLD), ties broken by newest createdAt. Cancelled rows
-- are audited below. Must run BEFORE the unique index is created.
-- A temp table carries the exact survivor/dupe split into the audit step (a
-- timestamp window would be non-deterministic).
CREATE TEMP TABLE t_inv_sync_dupes ON COMMIT DROP AS
WITH ranked AS (
  SELECT id,
         "unitId",
         row_number() OVER (
           PARTITION BY "unitId"
           ORDER BY CASE status
                      WHEN 'APPROVED' THEN 0
                      WHEN 'TOKEN'    THEN 1
                      ELSE 2
                    END,
                    "createdAt" DESC
         ) AS rn
  FROM "Booking"
  WHERE status IN ('HOLD', 'TOKEN', 'APPROVED')
)
SELECT id, "unitId", rn FROM ranked;

UPDATE "Booking" b
   SET status = 'CANCELLED',
       "updatedAt" = now()
  FROM t_inv_sync_dupes d
 WHERE b.id = d.id
   AND d.rn > 1;

-- Audit the cancellations (append-only ledger; org from the row itself).
INSERT INTO "AuditLog" (id, "userId", "organizationId", action, "entityType",
                        "entityId", before, after, reason)
SELECT 'inv-sync-' || md5(random()::text || b.id),
       NULL,
       b."organizationId",
       'booking.repair_cancel_duplicate',
       'Booking',
       b.id,
       jsonb_build_object('status', b.status),
       jsonb_build_object('status', 'CANCELLED'),
       'T-INV-SYNC migration: duplicate active booking on unit ' || b."unitId"
         || ' cancelled (one active booking per unit enforced)'
  FROM "Booking" b
  JOIN t_inv_sync_dupes d ON d.id = b.id
 WHERE d.rn > 1;

-- ── 4. Repair: recompute every unit from its bookings ──────────────────────
-- Units with zero bookings never fired the trigger, so stale marks left by
-- the seed roster (or by the silently-dropped role-scoped writes) persist.
-- Bookings are the source of truth: a unit with no live booking is AVAILABLE.
-- Single statement on purpose: calling the helper per row from inside an
-- UPDATE would re-touch the same tuple and Postgres rejects that.
WITH desired AS (
  SELECT u.id,
         (CASE
           WHEN EXISTS (SELECT 1 FROM "Booking" b
                         WHERE b."unitId" = u.id AND b.status = 'APPROVED') THEN 'SOLD'
           WHEN EXISTS (SELECT 1 FROM "Booking" b
                         WHERE b."unitId" = u.id AND b.status = 'TOKEN')    THEN 'TOKEN'
           WHEN EXISTS (SELECT 1 FROM "Booking" b
                         WHERE b."unitId" = u.id AND b.status = 'HOLD')     THEN 'HOLD'
           ELSE 'AVAILABLE'
         END)::"UnitStatus" AS st
    FROM "Unit" u
)
UPDATE "Unit" u
   SET status = d.st
  FROM desired d
 WHERE u.id = d.id
   AND u.status IS DISTINCT FROM d.st;

-- ── 5. One active booking per unit ─────────────────────────────────────────
-- Partial unique index: terminal states (REJECTED/CANCELLED) are exempt, so a
-- unit can accumulate booking history. P2002 from this index is mapped to a
-- typed 409 by bookings.service.ts.
CREATE UNIQUE INDEX "one_active_booking_per_unit"
  ON "Booking" ("unitId")
  WHERE status IN ('HOLD', 'TOKEN', 'APPROVED');

-- ── 6. Grants (self-contained, idempotent) ─────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "Unit" TO shadhil_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Booking" TO shadhil_app;
GRANT SELECT, INSERT ON "AuditLog" TO shadhil_app;
