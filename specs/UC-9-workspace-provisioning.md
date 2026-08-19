# UC-9 — Workspace provisioning from Clerk

**Status:** `done` · **Depends on:** UC-0 · **Blocks:** the first real deploy

## Goal

Close the one gap between "the code is done" and "a person can sign in and see their panel."

Migration `0001` says it out loud, and has said it since the first day of the repo:

> The tenant is the Clerk Organization (`workspaces.clerk_org_id`), **synced by the Clerk
> webhook**.

There is no Clerk webhook. `CLERK_WEBHOOK_SECRET` sits in `.env.example` and no file in the
repo reads it; `apps/web/src/app/api/` contains `health/` and nothing else. Every tenancy
guarantee in the product is built on a row that nothing creates.

## Why this is worth a UC rather than a line in the runbook

The failure is silent and it looks like a data bug.

A user signs up, Clerk mints an organization, the session carries `org_id`, and
`app.current_workspace_id()` runs its `select` against `public.workspaces` and finds nothing.
RLS then does exactly what it was built to do: every policy evaluates `workspace_id = null`,
every query returns zero rows, and **the dashboard renders empty with no error anywhere** —
not in the browser console, not in the server log, not in `audit_events`, because appending
one requires a `workspace_id` too.

An operator debugging this reads the crawl logs first, because an empty gallery looks like an
ingestion problem. That is the wrong half of the system, and it is where the runbook's SQL
sends them. The `insert into public.workspaces` workaround works and is documented, but a
manual step on the path between signup and first value is a step that gets skipped, done
wrong under time pressure, or forgotten entirely for the second organization.

## Scope

**In:** a signature-verified `POST /api/webhooks/clerk`; `organization.created`,
`organization.updated` and `organization.deleted`; the `workspaces` row those maintain; an
audit event per applied change; a backfill path for organizations that predate the webhook.

**Out:** users and memberships (see below); Clerk's user-facing onboarding; any UI. No new
dependency — `@clerk/nextjs@6.39` already exports `verifyWebhook` from `/webhooks` and bundles
Svix underneath it, so the signature check is not ours to implement.

### Why users and memberships are out

`app_users` and `workspace_members` exist in `0001` and **nothing in the product reads them.**
The active workspace comes from `org_id` in the JWT; the actor on every audit row comes from
`sub` in the JWT; watchlist CRUD stamps a `userActor(clerkUserId)` and never joins to a row.
The only writers today are `seedWorkspace` in the test helpers.

Provisioning them now would be write-only data: two tables kept in sync with Clerk, at the
cost of four more event types and their ordering problems, feeding nothing. When a feature
needs a per-member role — the first real candidate is restricting watchlist edits to
`owner`/`admin` — it arrives with the events that populate them. Named here so the omission
is a decision with a trigger, not an oversight.

## Design

### 1. `organization.deleted` must never delete the workspace row

This is the rule the whole UC is shaped around, and it inverts what the event name asks for.

Every table in the product cascades from `workspaces`: `watchlists`, `advertisers`,
`creatives`, `creative_observations`, `creative_features`, `creative_semantic_tags`,
`analysis_runs`, `audit_events` — all `on delete cascade`. A single `delete from workspaces`
is therefore the most destructive statement that exists in this system, and domain rule 1 is
what makes it unrecoverable rather than merely expensive: **the Ad Library has no history.**
Eight weeks of daily panel cannot be re-crawled at any price.

Deleting a Clerk organization is two clicks in a settings page, done by whoever holds the
owner seat, for reasons that have nothing to do with this product — consolidating two orgs,
cleaning up a test tenant, leaving. Wiring that click to a cascade delete puts the panel's
survival behind a UI we do not own and cannot add a confirmation to.

So the handler treats `organization.deleted` as **"stop spending, keep everything"**:

- Set `is_active = false` on every watchlist in the workspace. This is what actually needs to
  happen operationally — `app.enqueue_daily_crawls` reads `where is_active`, so a dead org's
  watchlists would otherwise keep minting crawl jobs and keep billing Apify every morning,
  forever, for data nobody can sign in to read.
- Leave the `workspaces` row, and every row that cascades from it, untouched.
- Append `workspace.deactivated` to the audit log with the count of watchlists stopped.

Deleting the data, if that is genuinely what is wanted, stays a deliberate operator action
with a runbook entry — the same posture as every other irreversible operation here.

### 2. The write goes over PostgREST with the service-role key

The web app has exactly one Postgres pool and it authenticates as `authenticator`, which
exists to be switched to `authenticated` for the length of one transaction so that RLS
applies to the app precisely as it applies in the tests (`packages/db/src/tenant.ts`).

A webhook has no session. There is no `org_id` claim to switch on — for
`organization.created` the whole point is that the workspace does not exist yet — so
`withTenant` cannot express this write, and teaching the pool to `set role service_role`
would put a "see and write every workspace" primitive inside the one process whose job is to
never have one.

The precedent is already in the repo, twice: `fetchIngestionHealth` (`packages/db/src/
health.ts`) and `posters.ts` both do their privileged, instance-wide work over PostgREST with
the service-role key as a server-only `fetch` credential. This is a third instance of that
same pattern, not a new one, and `RestCredentials` is the existing type for it.

### 3. Idempotent by construction, because Svix retries

Clerk redelivers on any non-2xx and on a timeout, so the handler will see the same event more
than once. The obvious tool does not fit: `withIdempotency` writes a `processed_messages` row
whose `workspace_id` is `not null` and references `workspaces` — which, for the event that
*creates* the workspace, does not exist yet. A ledger keyed on the thing the event is about to
mint cannot dedupe the minting.

The natural key is better anyway. `clerk_org_id` is `unique not null` and Clerk owns it, so
the handler reads before it writes:

- no row → `insert` → audit `workspace.provisioned`
- row exists, `name` or `slug` differs → `patch` → audit `workspace.renamed`
- row exists, identical → **no write, no audit**, `200`

A redelivery lands on the third branch and is silent, which is what "idempotent" has to mean
for an append-only audit log: a retry that appends a second `workspace.provisioned` is not a
duplicate write, it is a false claim that something happened twice.

Two concurrent deliveries can still race between the read and the insert. The loser gets a
`409` from PostgREST on the `clerk_org_id` unique constraint, and the handler treats that
exactly as it treats "row already exists" — the constraint is the real guarantee, and the read
is an optimization on top of it (same shape as `isUniqueViolation` in `jobs.ts`).

### 4. Out-of-order delivery changes a display name, and that is all

Svix does not guarantee ordering. Two `organization.updated` events delivered backwards leave
the older name in the row.

The honest v1 answer is that this does not matter, and it is worth writing down why rather
than adding a version column that would have to be defended: **`clerk_org_id` is the join
key and it never changes.** `name` and `slug` are display strings — the sidebar header and
nothing else. A stale one is cosmetic, and self-heals on the next rename. Comparing Clerk's
`updated_at` against ours would be comparing two clocks we do not control, which is a worse
guarantee than the one it replaces.

### 5. A missing slug is not a reason to drop the event

`workspaces.slug` is `not null unique`; Clerk's organization slug is optional and arrives
`null` when an org was created without one. Dropping the event would leave the user in the
silent-empty-dashboard state this UC exists to eliminate, over a cosmetic column. The handler
derives a fallback — slugified `name`, and failing that the `clerk_org_id` itself, which is
unique by construction — and records which one it used in the audit payload.

## Data model

**None.** No migration, no new table, no new column. `workspaces` has had the right shape
since `0001`; this UC only supplies the writer it always assumed. That is the reason it is
small enough to ship before the first deploy rather than after it.

## Rules

1. `organization.deleted` never deletes, never cascades. It deactivates watchlists and
   appends an audit event.
2. A request whose Svix signature does not verify gets `401` and writes nothing — not the
   row, not an audit event. `verifyWebhook` runs before anything else in the handler.
3. The route is listed as public in `middleware.ts`, which means "Clerk's session gate does
   not apply", not "ungated" — same wording and same reasoning as `/api/health/ingestion`.
4. Every write goes over PostgREST with the service-role key. The `authenticator` pool is
   never used here, and this route never calls `withTenant`.
5. A redelivery that changes nothing writes nothing, audit log included.
6. A `trace_id` is minted at ingress and stamped on every audit row the delivery produces
   (DashOne §3), so a provisioning question is answerable from `audit_events` alone.
7. The actor is `{type: 'agent', id: 'clerk-webhook'}` and passes `isActor` — asserted by
   calling the real predicate, not by restating its fields.

## Acceptance criteria

- [ ] `organization.created` with a valid signature creates the workspace and appends
      `workspace.provisioned`
- [ ] A redelivery of that same event creates nothing and appends nothing, and still answers
      `200`
- [ ] `organization.updated` with a changed name patches the row and appends
      `workspace.renamed`; with no change it writes nothing
- [ ] `organization.deleted` leaves the workspace row and every dependent row intact, sets
      `is_active = false` on its watchlists, and appends `workspace.deactivated`
- [ ] An invalid signature is `401`, and no row and no audit event exist afterwards
- [ ] An organization with a null slug is provisioned with a derived slug, and the audit
      payload says which fallback was used
- [ ] A concurrent duplicate delivery (simulated `409`) is absorbed, not surfaced as a `500`
      that Clerk would retry forever
- [ ] The route appears in `middleware.ts`'s public matcher, asserted by a test rather than
      by inspection
- [ ] After provisioning, `app.current_workspace_id()` resolves for a session carrying that
      `org_id` — proved through `asAuthenticated`, end to end from the event to a tenant read

## Test plan

| What | Fixture | Expected |
|---|---|---|
| Provision | `organization.created` payload | row inserted, `workspace.provisioned` audited |
| Redelivery | same payload twice | one row, one audit event, `200` both times |
| Rename | `organization.updated`, new name | row patched, `workspace.renamed` audited |
| No-op update | `organization.updated`, identical | no write, no audit event |
| Deletion | `organization.deleted` + seeded panel | workspace and creatives intact, watchlists inactive |
| Bad signature | tampered body | `401`, nothing written |
| Null slug | org payload without a slug | derived slug, fallback named in the audit payload |
| Race | injected `fetch` returning `409` | absorbed as already-provisioned, `200` |
| Public route | `middleware.ts` matcher | the webhook path is public, `/api/webhooks/x` is not |
| End to end | provision, then read as that org | `asAuthenticated` sees the workspace |

**Quick CLI check:**
```bash
psql -c "select w.slug, w.clerk_org_id, count(wl.id) filter (where wl.is_active) as active_watchlists
         from public.workspaces w
         left join public.watchlists wl on wl.workspace_id = w.id
         group by w.id, w.slug, w.clerk_org_id order by w.created_at;"
```

## Upgrade path

- `user.*` and `organizationMembership.*` once a feature reads `workspace_members` — the
  first real candidate is restricting watchlist edits to `owner`/`admin`.
- A backfill CLI, if the number of organizations predating the webhook ever exceeds the one
  or two a runbook `insert` handles comfortably.
- Ordering guarantees on renames, only if `slug` ever stops being cosmetic.
