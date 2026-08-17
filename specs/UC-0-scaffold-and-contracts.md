# UC-0 — Scaffold and cross-cutting contracts

**Status:** `done` · **Depends on:** — · **Blocks:** UC-1

## Goal

Stand up the thinnest repo that can legally and durably hold a daily crawl. Deliberately
minimal: UC-0 exists to unblock UC-1, not to be complete. Anything not required to record a
crawl safely belongs in a later UC.

## Scope

**In:**
- pnpm + Turborepo monorepo; `apps/web` (Next.js 15), `apps/extractor` (Python 3.12), `packages/*`
- Supabase project + migration runner applying SQL **automatically at startup** (DashOne §3 —
  never ask a human to run migrations)
- Migration `0001`: `workspaces`, `app_users`, `jobs`, `processed_messages`, `audit_events`
- RLS enabled with a policy on **every** table; CI greps migrations for a table without one
- Clerk wired for auth; Organizations as the tenant, active org read from the session JWT
- Doppler as the only secret source; `.env.example` with placeholders only
- `trace_id` (ULID `trc_…`) and `actor` minted at ingress and propagated
- CI gate: lint + typecheck + tests on every PR

**Out:** any Ad Library code, any UI beyond a sign-in and an empty shell, any analysis.

## Contracts (DashOne §3 — non-negotiable)

| Contract | Implementation |
|---|---|
| Multi-tenancy | every business table carries `workspace_id` + an RLS policy |
| `trace_id` | ULID `trc_…` minted at ingress, propagated end to end |
| `actor` | `{type: user\|schedule\|agent\|operator, id}` stamped at ingress |
| Audit | `audit_events`, append-only, queryable by actor / trace_id / type / date |
| Idempotency | `processed_messages` keyed on ULID `message_id`, written in the same tx as the side effect |
| Versioned envelopes | every job payload and raw snapshot carries `schema_version` |
| Secrets | Doppler → Vercel / Fly / Supabase via native integrations; never hand-copied |
| Migrations | applied automatically at startup by a runner with a tracking table |

## Acceptance criteria

- [x] Every table in `0001` has RLS enabled **and** a policy; the CI grep passes
      (`pnpm check:rls`, plus a live-catalog assertion in `packages/db/test/rls.test.ts`)
- [x] A user in workspace A cannot read workspace B's rows — proven by a failing-then-passing
      test (`rls.test.ts`; it failed first for a real reason, see Notes)
- [x] Enqueuing a job twice with the same `message_id` produces exactly one side effect
      (`jobs.test.ts`)
- [x] An `audit_events` row is queryable by `trace_id` (`jobs.test.ts`)
- [x] CI runs lint + typecheck + tests and blocks merge on failure (`.github/workflows/ci.yml`)
- [x] Migrations apply with **zero** manual SQL steps — `pnpm --filter @mini-crux/db migrate`,
      idempotent, run on deploy. Verified against PGlite; **not yet run against a real
      Supabase project** (none provisioned).
- [ ] `doppler run -- pnpm dev` boots web locally with no committed secret anywhere —
      **blocked**: no Doppler/Clerk/Supabase credentials exist yet. `pnpm build` is verified
      with placeholder keys, and the secret-hygiene grep passes.

## Test plan

| What to test | Steps | Expected |
|---|---|---|
| Tenant isolation | seed 2 workspaces, query as A | B's rows never returned |
| Migration idempotency | run the runner twice | second run is a no-op, tracking table unchanged |
| Job idempotency | enqueue same `message_id` twice | one `processed_messages` row, one side effect |
| Secret hygiene | `git grep` for key-shaped strings | no match outside `.env.example` placeholders |

## Notes

Keep this UC boring and small. Its only real job is to make UC-1 safe to ship tomorrow — the
crawl clock (`ARCHITECTURE.md` §3) is the thing actually under time pressure.

### What the tests caught (kept here because both were invisible on review)

1. **`0001` had never actually run.** Postgres validates a `language sql` function body at
   CREATE time, and `app.current_workspace_id()` was defined above the `workspaces` table it
   reads → `relation "public.workspaces" does not exist`. Fixed by moving each table-reading
   helper below its table.
2. **The RLS policies recursed.** `workspaces`' policy calls `app.current_workspace_id()`,
   which selects from `workspaces`, which re-applies the policy → `ERRORDATA_STACK_SIZE
   exceeded`. Fixed with `security definer` + `set search_path = ''`. Before it blew the
   stack it silently returned zero rows, which is the dangerous failure mode: a tenancy test
   that only checked "B's rows are absent" would have passed.

Both are now guardrails in `CLAUDE.md` so they cannot recur silently.
