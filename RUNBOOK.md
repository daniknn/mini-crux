# Runbook

Operating Mini Crux in production. Written for the person holding the pager at 09:00, so
every section leads with the decision and puts the reasoning underneath.

**The one thing to internalise:** the Meta Ad Library shows what is running *right now*. It
has no history. A day we fail to crawl is a day that does not exist, permanently, and no
amount of later work reconstructs it. Every urgency in this document derives from that.

---

## 1. What runs where

| Piece | Platform | What it does | Owns migrations |
|---|---|---|---|
| `mini-crux-worker` | Fly.io (`qro`) | Claims `crawl`, `parse`, `analysis`, `proxy_validation`, `semantic_tag` jobs | **Yes** — release command |
| `mini-crux-extractor` | Fly.io (`qro`) | Claims `extract` jobs (video features) | No |
| `@mini-crux/web` | Vercel (`qro1`) | Dashboard + `/api/health/ingestion` | No |
| Postgres + `pg_cron` | Supabase | The clock and the data | — |

Neither worker listens on a port. That is deliberate: a worker that is *up* but claiming
nothing is the failure worth catching, and a TCP health check calls that healthy. Liveness
is read from the `jobs` table and from the ingestion alarm.

### The daily clock

`pg_cron` entries, all in UTC — Postgres cron has no timezone:

| Job | UTC | Mexico City | What it does |
|---|---|---|---|
| `mini-crux-daily-crawl` | 14:00 | 08:00 | One `crawl` job per active watchlist |
| `mini-crux-daily-analysis` | 16:00 | 10:00 | One `analysis` job per workspace with a healthy crawl |
| `mini-crux-reap-stalled-jobs` | `:00,:15,:30,:45` | same | Returns jobs from dead workers to the queue |

The two-hour gap between crawl and analysis is sized by how long the crawl and extraction
take, not by the analysis, which is milliseconds of arithmetic. If the crawl has not
succeeded by 16:00 the analysis tick enqueues nothing and yesterday's published run stands
— correct behaviour, not a missed window.

`proxy_validation` (UC-7) is deliberately **absent** from this table. In the EU, longitudinal
data can be backfilled from one scrape — there is no daily tick to backfill for, and adding one
would imply this is a panel to maintain rather than a research instrument to run once in a
while. See *Run the ES proxy validation* in §5.

`semantic_tag` (UC-8) is deliberately **absent** too, for a different reason: a VLM call costs
money per creative, where a crawl or a re-analysis does not. Auto-enqueueing it on the same
clock as extraction would mean an unbounded, recurring API bill for creatives that were already
tagged at the current taxonomy version. `app.enqueue_pending_semantic_tags` exists precisely so
this stays an operator decision — see *Run the semantic tagging backlog* in §5.

```sql
select jobname, schedule, active from cron.job order by jobname;
```

---

## 2. The alarm

`GET /api/health/ingestion`, gated by `HEALTH_CHECK_TOKEN`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "authorization: Bearer $HEALTH_CHECK_TOKEN" \
  https://<app>/api/health/ingestion
```

`200` = every active watchlist has today's crawl. `503` = something needs you. Point any
uptime checker at it; it needs to understand nothing but the status code.

The same verdict renders on **/listas** in the dashboard, so you can confirm by eye without
trusting that an alert would have fired.

### Reading the body

```json
{
  "status": "degraded",
  "marketDate": "2026-03-10",
  "counts": { "watchlists": 3, "succeeded": 2, "inFlight": 0, "offenders": 1 },
  "offenders": [{ "label": "Fintech MX", "reason": "never-started", "error": null }]
}
```

`marketDate` is the **market's** calendar day (America/Mexico_City), never the reader's.
Between 18:00 and 24:00 in Mexico City it is already tomorrow in UTC — if you compare this
against a UTC clock in the evening you will think it is a day behind. It is not.

---

## 3. Alarm responses

The four reasons need four different actions. This is the section the endpoint exists for.

### `never-started` — no crawl was attempted

**The expensive one.** Nothing is broken downstream; something upstream never asked, so
there is nothing to retry until it is scheduled. Work down this list:

1. **Is the watchlist active and was it created before the tick fired?**
   ```sql
   select id, label, is_active, created_at from public.watchlists where is_active;
   ```
   A watchlist created at 09:00 missed the 08:00 tick. Not a fault — it starts tomorrow.
   If you want today, see *Force a crawl now* below.

2. **Did pg_cron fire at all?**
   ```sql
   select j.jobname, r.status, r.start_time, r.return_message
   from cron.job_run_details r join cron.job j using (jobid)
   where r.start_time > now() - interval '1 day'
   order by r.start_time desc;
   ```
   No row = cron did not run. Check the Supabase project is not paused (free-tier projects
   pause after inactivity and `pg_cron` stops with them).

3. **Did the tick enqueue a job that nobody claimed?**
   ```sql
   select id, type, status, attempts, last_error, created_at
   from public.jobs where created_at > now() - interval '1 day' order by created_at desc;
   ```
   `pending` rows piling up means the worker is not running: `fly status -a mini-crux-worker`
   and `fly logs -a mini-crux-worker`.

### `failed` — the crawl ran and lost

**Recoverable, and only today.** The error is in the offender's `error` field and in
`crawl_runs.error`. Provider outage, rate limit, and bad actor input all land here.

Fix the cause, then re-run before midnight in Mexico City:

```bash
fly ssh console -a mini-crux-worker \
  -C "node /app/packages/ingestion/src/cli.ts --watchlist <id>"
```

Absolute path on purpose: `fly ssh console` starts at `/`, not at the image's `WORKDIR`.

After midnight the day is gone. Do not spend the morning debugging something you can
re-run in a minute — re-run first, debug after.

### `stalled` — running for over an hour

The worker that claimed it is almost certainly dead. The reaper returns the job to the
queue within 20 minutes and it retries by itself, so **the first response is to wait one
reaper cycle.** If it is still stalled after that:

```sql
select id, type, status, attempts, started_at, heartbeat_at, last_error
from public.jobs where status = 'running' order by heartbeat_at;
```

There is deliberately no "which worker holds it" column to select. `app.claim_job` uses
`for update skip locked` and stamps `heartbeat_at`, never an owner id, so a stale
`heartbeat_at` *is* the answer to that question — the claim belongs to whichever process has
stopped beating, and reaping is keyed on the timestamp rather than on identity. If you find
yourself wanting the owner, what you actually want is `fly logs -a mini-crux-worker` around
`started_at`.

A `heartbeat_at` that is not advancing with a worker that *is* running means the handler is
blocked, not the process — check `fly logs`. Restart with `fly apps restart mini-crux-worker`;
SIGTERM lets the job in flight finish and report.

### `suspect` — results fell off a cliff

Data landed, but the count dropped far enough from its neighbours that the panel may have
half-loaded. The analysis tick **refuses** a suspect panel date on purpose, so the dashboard
silently stops updating — which is why this is an alarm and not a note.

```sql
select run_date, result_count, previous_count, status
from public.crawl_runs where watchlist_id = '<id>' order by run_date desc limit 10;
```

If the drop is real (the advertiser genuinely stopped ads), no action — tomorrow's run
re-baselines. If it is an artifact, re-run the crawl as for `failed`.

### `unknown` — the alarm could not read the database

`503` with `"status": "unknown"` means the endpoint itself could not answer, **not** that
ingestion failed. Ingestion may be perfectly fine. Check Supabase status and that the web
app still holds `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.

### `401`

The token is wrong or missing. `HEALTH_CHECK_TOKEN` in Doppler must match what the checker
sends as `authorization: Bearer …`. A `500` with `"misconfigured"` means the variable is
absent from the web app's environment entirely.

---

## 4. Deploying

### Order matters on the first deploy

1. **Supabase project**, then put `SUPABASE_DB_URL` (direct, port 5432, `postgres` user) and
   `SUPABASE_DB_AUTHENTICATOR_URL` (pooled, port 6543, `authenticator` user) into Doppler.
2. **Worker.** Its release command applies every migration, including the `pg_cron` entries.
   Nothing else works until this succeeds.
   ```bash
   fly deploy --config apps/worker/fly.toml
   ```
3. **Extractor.** Reads the schema the worker applied.
   ```bash
   fly deploy --config apps/extractor/fly.toml
   ```
4. **Web.** Vercel, root directory `apps/web`.
5. **Uptime checker** pointed at `/api/health/ingestion` with the bearer token.

### Migrations

They run as the worker's release command — once per deploy, on a temporary machine, before
any new machine serves. A non-zero exit **aborts the deploy** and leaves the previous
release running, which is the entire reason it is a release command and not a startup step:
a migration that fails must stop the code depending on it from shipping, not race it.

Never run them by hand (DashOne §3). If you need to see what would happen:

```sql
select version, applied_at from public.schema_migrations order by version;
```

The runner is idempotent and checksums every file. A checksum mismatch means a migration was
edited after being applied — the fix is a new migration, never an edit to the old one.

### When a migration fails

**You are not in an outage.** The deploy aborted, the previous release is still serving, and
the crawl clock is untouched — `pg_cron` lives in the database and does not care that a
deploy failed. Nothing is burning; you have until 14:00 UTC tomorrow.

The failing statement is in the deploy output:

```bash
fly logs -a mini-crux-worker | grep -i migrat
```

Each migration runs in its own transaction, so a failure leaves *that* file fully rolled
back and no row in `schema_migrations`. Confirm which one is the boundary:

```sql
select version, applied_at from public.schema_migrations order by version desc limit 5;
```

Fix forward in a new commit and redeploy. Do **not** hand-apply the statement to unstick the
deploy: the runner would then find the object already present, the migration would fail again
for a new reason, and the database's real version stops matching what `schema_migrations`
claims — which is the state every one of these guarantees is built to avoid.

The one case that is not fix-forward: a migration that succeeded on a *previous* deploy and
whose checksum has since changed. That means someone edited applied SQL. Restore the file to
what shipped (`git log -p supabase/migrations/<file>`) and put the change in a new migration.

### Secrets

Doppler is the only source (DashOne §3). Nothing is in a `Dockerfile`, `fly.toml`,
`vercel.json`, or any committed file, and CI fails on key-shaped strings outside
`.env.example`. Add a variable → Doppler config + `.env.example` placeholder + read it
through `serverEnv()` / `loadSettings()`, which fail fast when it is missing.

**The one that must never be confused:** workers get `SUPABASE_DB_URL` (BYPASSRLS). The web
app gets `SUPABASE_DB_AUTHENTICATOR_URL` and never the former. Handing the web app the
worker's URL serves every workspace's panel to everyone — with a green test suite, because
the tests connect as `authenticated`.

**`OPENAI_API_KEY`** (worker only) backs the VLM provider for `semantic_tag` jobs — fails fast
at startup if absent (`apps/worker/src/config.ts`), same as every other required setting.
`VLM_MODEL` is optional and defaults to `gpt-4o-mini`; changing it does **not** need a taxonomy
version bump (§5) — `SEMANTIC_SCHEMA_VERSION` tracks the prompt and taxonomy, not the model
that answers it.

### Rotating one

Change it in Doppler, then make each platform pick it up. Neither reads Doppler at runtime —
both hold a copy, so a rotation that stops at Doppler changes nothing anywhere.

```bash
doppler secrets set HEALTH_CHECK_TOKEN=<new>          # the source
doppler run -- fly secrets set HEALTH_CHECK_TOKEN=... # or `doppler integrations`
# Vercel: redeploy — env vars are bound at build time for the server bundle
```

`fly secrets set` restarts the machines. That is safe by design: SIGTERM lets the job in
flight finish and report, and anything that dies mid-crawl is returned to the queue by the
reaper within 20 minutes. Rotating during the 14:00–16:00 UTC crawl window is still the one
avoidable risk, because a restart there costs the crawl its remaining time, and the day
cannot be re-crawled tomorrow. Rotate in the afternoon, market time.

Two have an ordering that matters:

- **`HEALTH_CHECK_TOKEN`** — update the *uptime checker* in the same sitting. Between the two
  changes the alarm returns `401`, which is a page in the middle of the night for a change
  nobody remembers making. If the checker cannot be updated first, expect that page.
- **`SUPABASE_SERVICE_ROLE_KEY`** — held by the web app (for the health read and signed
  poster URLs) *and* the ingestion CLI. Rotating in Supabase invalidates the old key
  immediately, so both must be redeployed; the web app is the one that shows it, as the
  alarm flipping to `"status": "unknown"`.

Rotating `APIFY_TOKEN` is the safest of the set — nothing holds it but the worker, and a
wrong value surfaces as a `failed` crawl with the provider's error in `crawl_runs.error`.

### `vercel.json`

Build and install commands `cd ../..` because Vercel's root directory is `apps/web` but the
pnpm lockfile is at the repo root. `no-store` on the health route is belt-and-braces
alongside `dynamic = 'force-dynamic'` in the handler: a cached alarm reports the state of the
last build, which is the most confidently wrong thing an alarm can do.

---

## 5. Common operations

**Force a crawl now** (new watchlist, or recovering a failed day):
```bash
fly ssh console -a mini-crux-worker \
  -C "node /app/packages/ingestion/src/cli.ts --watchlist <id> [--date YYYY-MM-DD]"
```
It goes through the scheduler's own `app.enqueue_daily_crawls`, then the same crawl and
parse path a scheduled run takes — a manual recovery cannot diverge from a normal day.
`--date` only reaches back to a day the Ad Library still shows, which is today.

**Analyze a panel the tick skipped.** If a workspace has a `succeeded` crawl for the date and
no run yet — the usual cause is the 16:00 UTC tick firing before a late crawl landed:
```sql
select app.enqueue_daily_analysis('2026-03-10'::date);
```
Returns the number of jobs created, across every workspace in that state. **`0` is the normal
answer once the panel has been analyzed**, and it does not mean the call failed: the tick
skips any workspace that already has an `analysis_runs` row for the date. To analyze that date
*again*, see below — `enqueue_daily_analysis` will never do it.

**Force a re-analysis of a date already analyzed.** Enqueue the job directly. This is the one
operation with no function wrapping it, because nothing scheduled should ever want it:
```sql
insert into public.jobs (workspace_id, message_id, type, payload, trace_id, actor)
values (
  '<workspace-uuid>',
  app.new_ulid('msg_'),
  'analysis',
  jsonb_build_object('panel_date', '2026-03-10'),
  app.new_ulid('trc_'),
  jsonb_build_object('type', 'operator', 'id', '<your-name>', 'label', 're-analysis')
);
```
Three things make this safe, and each would otherwise look like a reason not to do it:

- **Do not delete the old `analysis_runs` row first.** You cannot — it is append-only, guarded
  by a trigger, not just a revoke. The new run is appended alongside it, and the old one
  becomes history rather than a conflict.
- **The fresh `message_id` is the point.** The handler wraps `runAnalysis` in the idempotency
  ledger keyed on exactly that value, so reusing the previous job's id would record the job as
  already processed and skip the work silently.
- **The unique index will refuse a duplicate while one is in flight** — it covers `analysis`
  jobs in `pending` or `running` for that `(workspace_id, panel_date)`. If the insert raises a
  unique violation, an analysis for that date is already queued and you want to wait for it,
  not force a second.

What the operator sees afterwards depends on *which* date was re-analyzed, and this is the
part that wastes an hour if it is not said here. The analysis page renders the **newest run in
the workspace**, ordered by `created_at` and not by panel date. Re-analyzing today's panel
therefore replaces what is on screen; re-analyzing a date from last week appends a run that
nothing displays, and it is read back with a direct query:
```sql
select id, created_at, outcome, failed_gate, n_long, n_short
from public.analysis_runs
where workspace_id = '<workspace-uuid>' and panel_date = '2026-03-10'
order by created_at desc;
```
Either way, say so to whoever reads the panel: a second run of the same date over extractions
that have since completed is a legitimately different answer, and it will not look like one.

**Extraction backlog** — creatives with no current features row:
```bash
fly ssh console -a mini-crux-extractor \
  -C "/app/.venv/bin/python -m extractor.run --reconcile"
```

**Re-extract everything after a feature change** — marks rows below version `N` stale and
enqueues re-extraction:
```bash
fly ssh console -a mini-crux-extractor \
  -C "/app/.venv/bin/python -m extractor.run --bump-version 2"
```

**Follow one request end to end.** Every ingress mints a `trace_id` and it propagates
through the whole chain:
```sql
select * from public.audit_events where trace_id = 'trc_…' order by created_at;
select id, type, status, created_at from public.jobs where trace_id = 'trc_…';
```

**Queue depth:**
```sql
select type, status, count(*) from public.jobs group by 1, 2 order by 1, 2;
```

**Run the ES proxy validation (UC-7).** A research instrument, triggered deliberately — never
by cron (see §1). It crawls Spain, classifies and gates the corpus, and stores a
`proxy_validation_runs` row in one call:
```bash
fly ssh console -a mini-crux-worker \
  -C "node /app/packages/ingestion/src/proxy-validation-cli.ts \
      --workspace <workspace-uuid> --kind keyword --query <term>"
```
No `jobs` row backs this — it runs in-process, like `crawl:once` — so it never appears in the
*Queue depth* query above. A re-run corrects the existing corpus in place (upserted on
`workspace_id, ad_archive_id`) rather than duplicating it; the acceptance criterion is that a
second crawl of the same query does not double the corpus.

**Read the last ES validation verdict:**
```sql
select id, created_at, outcome, failed_gate, beta, beta_ci_low, beta_ci_high, verdict
from public.proxy_validation_runs
where workspace_id = '<workspace-uuid>'
order by created_at desc limit 5;
```
`proxy_validation_ads` and `proxy_validation_runs` never join to `creatives`,
`creative_observations`, `creative_survival`, `advertisers`, `watchlists` or `crawl_runs` — in
either direction (migration 0011). If a query needs one of those tables to make sense, it is
asking about the MX panel and belongs in a different section. The verdict changes what the
`/validacion-proxy` page *says*, never what UC-5 computes: no MX gate, threshold or copy reads
it automatically, and none should be made to.

**Run the semantic tagging backlog (UC-8).** Not cron-scheduled (§1) — each call spends real
money, one VLM call per newly-eligible creative, so it is an operator decision rather than a
tick. The argument is the current `SEMANTIC_SCHEMA_VERSION`:
```sql
select app.enqueue_pending_semantic_tags(1);
```
Returns the number of `semantic_tag` jobs created. It only considers creatives whose
`creative_features` row is current (`not is_stale`) and has `semantic_frame_paths` — tagging
cannot run ahead of frames the extractor has not produced yet, so a fresh crawl needs a normal
extraction pass to finish first. **`0` is the normal answer once the panel is fully tagged at
that version**, same reading as `enqueue_daily_analysis` — it is not a failure. Re-running it
is safe: the `where not exists` clause against both `creative_semantic_tags` and in-flight
`jobs` rows means a second call the same afternoon costs nothing extra, it just finds nothing
left to enqueue.

**Re-tag everything after a taxonomy or prompt change.** `SEMANTIC_SCHEMA_VERSION`
(`packages/ingestion/src/semantic-tagging.ts`) bumps only when the prompt or the `hook_type` /
`tone` taxonomy itself changes — never for a model swap that leaves the question asked
unchanged (see `VLM_MODEL` in §4). Same two-step shape as the extractor's `--bump-version`:
first mark every row below the new version stale, then let the reconciler above queue their
replacements:
```sql
select app.mark_semantic_tags_stale(2);
select app.enqueue_pending_semantic_tags(2);
```
Split in two on purpose: staleness is a fact about the existing rows and has to be recorded
even if the worker is down or the re-tag never runs, so a superseded taxonomy never presents
as current in the meantime. The old rows are not deleted — `is_stale = true`, readable, same
lifecycle as `creative_features.is_stale` — so a taxonomy change is auditable, not just applied.

**Read a creative's current tags:**
```sql
select creative_id, schema_version, has_people_on_screen, hook_type, tone, skipped_tags,
       vlm_provider, vlm_model, is_stale
from public.creative_semantic_tags
where creative_id = '<id>'
order by schema_version desc;
```
A `null` in `has_people_on_screen`/`hook_type`/`tone` with a matching entry in `skipped_tags`
means the model declined that specific field — not that it answered false/empty. `raw_response`
on the same row is the untouched provider payload (land raw, parse later, domain rule 2, applied
to a model response) — the first place to look when a parsed field looks wrong, since a
reprocess against that column costs nothing further, unlike a second VLM call.

---

## 6. What cannot be recovered

Be honest with yourself about these, because effort spent trying is effort not spent on the
next day's crawl.

- **A missed day.** The Ad Library has no history. Nothing reconstructs it.
- **Survival before a watchlist existed.** Duration runs forward only. A watchlist created
  today produces its first useful contrast in roughly eight weeks.
- **`creative_observations`.** Append-only, enforced by trigger. Absence is recorded as
  `is_present = false`, never as a missing row — so never `update` and never `delete` here.
  A wrong row is corrected by a new observation, not by editing history.

## 7. Things that are fine and look alarming

- **Red on `/listas` at 08:05** while a crawl is in flight — the alarm allows an hour of
  grace before calling it stalled, so this should not happen; if it does, the crawl started
  before 07:00 or the state is genuinely `never-started`. Read the reason, not the colour.
- **`analysis_runs.outcome = 'refused'`.** The statistical gate declined to publish (panel
  too young, cohorts too small). Working as designed — the alternative is a confident number
  computed from eleven creatives.
- **Extraction features recorded as `skipped`.** A model backend was unavailable and the
  pipeline degraded per feature instead of failing the job. Check the image has the `ml`
  extra if *every* creative skips the same feature.
- **A `creative_semantic_tags` row with one or two fields null and named in `skipped_tags`.**
  The VLM declined that specific field rather than guessing — the job still succeeded and wrote
  whatever it did answer. Only worth a look if *every* row skips the *same* field, which points
  at the prompt rather than any one creative.
- **`creative_semantic_tags.is_stale = true` rows sitting around after a taxonomy bump.** They
  are superseded, not orphaned — kept for audit, same as `creative_features.is_stale`. They stop
  once `enqueue_pending_semantic_tags` finishes the backlog for the new version.
