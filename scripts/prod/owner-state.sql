-- Owner-split state fingerprint.
--
-- Emits one stable, sorted blob describing who owns what and who may do what. Run it
-- before the cutover, after the cutover, and after a rollback, then diff the three runs.
-- A text diff is the only honest way to answer "did the rollback restore the database",
-- because the answer is a set of grants, not a boolean.
--
-- Deliberately does NOT include the grantor. `ALTER TABLE ... OWNER TO` rewrites the
-- grantor of every ACL entry to the new owner, so a before/after diff that included it
-- would report a difference on every single table even when the grantees are identical.
-- The thing that matters for access is grantee + privileges, and that is what this prints.
--
-- Usage (inside the postgres container):
--   psql -U shadhil -d shadhil_crm -f owner-state.sql

\pset tuples_only on
\pset format unaligned
\pset fieldsep ' '
\echo '## objects by owner'
SELECT 'rel ' || pg_get_userbyid(c.relowner) || ' ' || count(*)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
   -- The cutover's ACL record lives here while a cutover is in flight and the rollback
   -- drops it. Counting it would make every after-cutover diff look dirty for a table
   -- that is bookkeeping rather than schema.
   AND c.relname <> '_owner_split_acl'
 GROUP BY pg_get_userbyid(c.relowner) ORDER BY 1;

SELECT 'fn ' || pg_get_userbyid(p.proowner) || ' ' || count(*)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
 GROUP BY pg_get_userbyid(p.proowner) ORDER BY 1;

SELECT 'type ' || pg_get_userbyid(t.typowner) || ' ' || count(*)
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
 GROUP BY pg_get_userbyid(t.typowner) ORDER BY 1;

\echo '## schema and database'
SELECT 'schema public owner ' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public';
SELECT 'database owner ' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database();

\echo '## roles'
SELECT 'role ' || rolname || ' super=' || rolsuper::text || ' bypass=' || rolbypassrls::text
       || ' login=' || rolcanlogin::text
  FROM pg_roles
 WHERE rolname IN ('shadhil', 'shadhil_app', 'shadhil_owner', 'shadhil_rls', 'shadhil_seed', 'studio_ro')
 ORDER BY rolname;

\echo '## counts that must not move'
SELECT 'policies ' || count(*) FROM pg_policies WHERE schemaname = 'public';
SELECT 'migrations ' || count(*) FROM _prisma_migrations;
SELECT 'secdef ' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef;

\echo '## table privileges, grantee and privileges only'
SELECT 'tbl ' || c.relname || ' ' || a.grantee_role || ' ' || a.privs
  FROM (
    SELECT c.oid, c.relname,
           CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee_role,
           string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) AS privs
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_owner_split_acl'
     GROUP BY c.oid, c.relname, x.grantee
  ) a
  JOIN pg_class c ON c.oid = a.oid
 ORDER BY 1;

\echo '## function privileges'
SELECT 'fnp ' || p.proname || ' ' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
       || ' ' || x.privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(p.proacl) AS x
 WHERE n.nspname = 'public'
 ORDER BY 1;
