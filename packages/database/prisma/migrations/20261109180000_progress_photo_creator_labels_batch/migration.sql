-- Set-based creator labels for a timeline page (2026-11-09).
--
-- WHY: readTimelinePage resolved a creator label by calling
-- progress_photo_creator_label() once per photo. Measured on the dev DB, 50
-- sequential calls cost 117ms against 6ms for the same work done set-based -
-- about 2.3ms of pure PL/pgSQL call overhead per photo, ~150 internal queries
-- per page, all serialized because $queryRaw inside an interactive transaction
-- runs on one pinned connection.
--
-- SECURITY POSTURE IS UNCHANGED, deliberately:
--   * Still SECURITY DEFINER with search_path locked, because TeamMember RLS
--     hides other members' rows from the caller by design.
--   * Same fail-closed GUC guard: no app.user_id / role / org -> zero rows.
--   * Same org check per photo.
--   * Same visibility predicate (ADMIN, member via ProjectTeam->TeamMember,
--     linked team's manager, or the slice-2 customer arm) applied PER PHOTO,
--     never once for the batch. A photo the caller may not read contributes no
--     row, so it reads "Unknown" exactly as before.
--   * Same photo-lead resolution for the creator.
--
-- Returns AT MOST one row per id the caller can read. Ids that fail any gate
-- are simply absent, which the mapper treats as (null, null) - the same
-- "Unknown" the single-call version returned.

CREATE OR REPLACE FUNCTION progress_photo_creator_labels(p_photo_ids TEXT[])
RETURNS TABLE (photo_id TEXT, creator_name TEXT, creator_is_photo_lead BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_role    TEXT;
  v_org_id  TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_role    := current_setting('app.user_role', true);
  v_org_id  := current_setting('app.user_org_id', true);

  -- No valid RLS context: fail closed (zero rows, not an error).
  IF v_user_id IS NULL OR v_role IS NULL OR v_org_id IS NULL THEN
    RETURN;
  END IF;

  -- No ids: nothing to resolve. Avoids a pointless scan on an empty page.
  IF p_photo_ids IS NULL OR array_length(p_photo_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      p."id"::TEXT,
      u."name"::TEXT,
      EXISTS (
        SELECT 1 FROM "ProjectStaffRole" psr2
         WHERE psr2."userId" = p."createdBy"
           AND psr2."kind" = 'PHOTO_LEAD'
           AND psr2."projectId" = ph."projectId"
      ) AS creator_is_photo_lead
    FROM "ProgressPhoto" p
    -- Org gate: the same predicate the single-call version applied.
    JOIN "Unit"  un ON un."id" = p."unitId"
    JOIN "Phase" ph ON ph."id" = un."phaseId"
    -- Creator: absent when the account was deleted, matching the old
    -- "creator deleted -> (NULL, NULL)" branch via the INNER JOIN.
    JOIN "User"  u  ON u."id" = p."createdBy"
    WHERE p."id" = ANY (p_photo_ids)
      AND p."organizationId" = v_org_id
      -- PER-PHOTO visibility. Mirrors the SELECT policy shape exactly.
      AND (
        v_role = 'ADMIN'
        OR (v_role = 'CUSTOMER' AND customer_can_read_unit(p."unitId"))
        OR EXISTS (
          SELECT 1
            FROM "ProjectTeam" pt
            LEFT JOIN "TeamMember" tm
              ON tm."teamId" = pt."teamId" AND tm."userId" = v_user_id
            LEFT JOIN "Team" t
              ON t."id" = pt."teamId" AND t."managerId" = v_user_id
           WHERE pt."projectId" = ph."projectId"
             AND (tm."userId" IS NOT NULL OR t."id" IS NOT NULL)
        )
      );
END;
$$;

REVOKE ALL ON FUNCTION progress_photo_creator_labels(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION progress_photo_creator_labels(TEXT[]) TO shadhil_app;
