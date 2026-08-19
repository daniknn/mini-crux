-- 0008_audit_append_only.sql
-- Make the audit log's append-only promise true rather than configured.
--
-- 0001 created `audit_events` as append-only and enforced it the way the rest of that
-- migration enforces things: no update or delete policy, and
-- `revoke update, delete … from anon, authenticated, service_role`. In production that is
-- real — Supabase's bootstrap runs `alter default privileges … grant all on tables to
-- anon, authenticated, service_role`, so the table arrives with UPDATE and DELETE already
-- granted and the revoke is what takes them away.
--
-- Under PGlite there is no such bootstrap. Those privileges were never granted, so the
-- revoke is a no-op and the tests in `rls.test.ts` that assert "permission denied" pass
-- whether or not the revoke line exists in the migration. That was measured while building
-- 0007, by deleting the equivalent revokes from that file and watching the suite stay
-- green. So the strongest guarantee in this schema — the one that says the audit trail
-- cannot be rewritten — was also the least verified.
--
-- 0007 settled on a trigger for the analysis tables, for the same reason it applies here: a
-- trigger does not care about grants. It holds for the table owner, for the service role
-- the writers actually use, for a future migration that re-grants by accident, and for a
-- psql session belonging to whoever is debugging at 2am — and it can be proved in PGlite by
-- granting the privileges back and watching the write fail anyway. The revokes in 0001 stay
-- as they are: refusing the privilege is better than allowing the attempt and erroring.
--
-- 0001 is not edited. It has been applied and the runner tracks its checksum.

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function app.reject_mutation();
