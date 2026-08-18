-- 0003_schedule.sql
-- The daily tick that starts the crawl clock.
--
-- Why the enqueue logic lives in SQL
-- ----------------------------------
-- pg_cron executes SQL inside the database; it cannot call application code. Putting the
-- tick here also means the "exactly one crawl per watchlist per day" guarantee is a
-- database constraint (`crawl_runs unique (watchlist_id, run_date)`) rather than an
-- application check that a concurrent retry could race past.
--
-- The tick is deliberately thin: it creates the crawl_run row and enqueues a job. All the
-- real work — calling the provider, landing raw, parsing — happens in the worker, so a
-- slow or failing crawl never blocks the scheduler.

------------------------------------------------------------
-- ULID minting in SQL
------------------------------------------------------------
-- The `trace_id` / `message_id` contract (DashOne §3) says ULID, and the tick is ingress:
-- it is where the trace for a whole day's pipeline is born. Since the tick runs inside
-- Postgres, the id has to be mintable there too — packages/core mints the identical shape
-- for ids originating in TypeScript.
--
-- Crockford base32, excluding I, L, O and U so the alphabet has no visually ambiguous
-- characters: 10 chars of millisecond timestamp + 16 chars of randomness.
--
-- `random()` is not a CSPRNG. That is acceptable here and only here: a ULID's random block
-- exists for collision resistance within a millisecond, not for unguessability. Nothing in
-- this system treats a trace_id or message_id as a secret or a capability.

create or replace function app.new_ulid(prefix text default '')
returns text
language plpgsql
volatile
as $fn$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms       bigint  := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  body     text    := '';
  i        integer;
begin
  -- 48-bit timestamp, most significant group first. Ten 5-bit groups span 50 bits; the
  -- top two are always zero until the year 10889.
  for i in reverse 9..0 loop
    body := body || substr(alphabet, (((ms >> (i * 5)) & 31))::integer + 1, 1);
  end loop;

  for i in 1..16 loop
    body := body || substr(alphabet, floor(random() * 32)::integer + 1, 1);
  end loop;

  return prefix || body;
end
$fn$;

------------------------------------------------------------
-- The daily tick
------------------------------------------------------------
-- Returns the number of crawls actually enqueued, so a run that was already ticked today
-- is observably a no-op rather than silently indistinguishable from a run with no
-- watchlists.
--
-- SECURITY DEFINER because pg_cron runs it as the job owner and it must write across every
-- workspace; `search_path = ''` is the mandatory companion (see CLAUDE.md).

create or replace function app.enqueue_daily_crawls(target_date date default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  -- Prefixed to avoid colliding with the `run_date` column inside the INSERT below;
  -- plpgsql resolves an ambiguous name as an error, not as the column.
  v_run_date date;
  v_watchlist record;
  v_run_id   uuid;
  v_trace_id text;
  v_created  integer := 0;
begin
  -- The crawl's logical day is the market's day, not UTC's. A tick at 08:00 in Mexico
  -- City must not land on the previous or next calendar date in the panel. Single market
  -- by design (ARCHITECTURE.md §10.5); when a second one is added this becomes a per-
  -- watchlist timezone.
  v_run_date := coalesce(
    target_date,
    (now() at time zone 'America/Mexico_City')::date
  );

  for v_watchlist in
    select id, workspace_id
    from public.watchlists
    where is_active
    order by created_at
  loop
    -- The unique constraint is the enforcement mechanism. `do nothing` means a second
    -- tick on the same day returns no id, and no job is enqueued.
    insert into public.crawl_runs (workspace_id, watchlist_id, run_date, trace_id, actor)
    values (
      v_watchlist.workspace_id,
      v_watchlist.id,
      v_run_date,
      app.new_ulid('trc_'),
      jsonb_build_object('type', 'schedule', 'id', v_watchlist.id::text, 'label', 'daily-crawl')
    )
    on conflict (watchlist_id, run_date) do nothing
    returning id, trace_id into v_run_id, v_trace_id;

    continue when v_run_id is null;

    insert into public.jobs (workspace_id, message_id, type, payload, trace_id, actor)
    values (
      v_watchlist.workspace_id,
      app.new_ulid('msg_'),
      'crawl',
      jsonb_build_object(
        'crawl_run_id', v_run_id,
        'watchlist_id', v_watchlist.id,
        'run_date', v_run_date
      ),
      v_trace_id,
      jsonb_build_object('type', 'schedule', 'id', v_watchlist.id::text, 'label', 'daily-crawl')
    );

    v_created := v_created + 1;
    v_run_id := null;
  end loop;

  return v_created;
end
$fn$;

revoke execute on function app.enqueue_daily_crawls(date) from public, anon, authenticated;

------------------------------------------------------------
-- Schedule
------------------------------------------------------------
-- Guarded because pg_cron is a Supabase-managed extension that does not exist in the
-- PGlite harness the test suite runs against. The same migration therefore applies
-- unmodified in both places — the alternative, a Supabase-only migration, would mean the
-- tested schema and the deployed schema are not the same schema.
--
-- 14:00 UTC = 08:00 in Mexico City. Early enough that a failed crawl leaves most of the
-- working day to retry inside the same panel date, which matters because a missed day
-- cannot be backfilled.

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    if not exists (select 1 from cron.job where jobname = 'mini-crux-daily-crawl') then
      perform cron.schedule(
        'mini-crux-daily-crawl',
        '0 14 * * *',
        $cron$select app.enqueue_daily_crawls()$cron$
      );
    end if;
  else
    raise notice 'pg_cron unavailable: app.enqueue_daily_crawls() defined but not scheduled.';
  end if;
end
$do$;
