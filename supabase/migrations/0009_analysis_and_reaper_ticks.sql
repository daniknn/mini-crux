-- 0009_analysis_and_reaper_ticks.sql
-- The two ticks that were missing, and the constraint that makes one of them safe.
--
-- 0003 scheduled the daily crawl. Nothing ever scheduled the analysis, so `analysis_runs`
-- filled up only when a test wrote to it; and `app.reap_stalled_jobs` — defined in 0004,
-- covered by `extraction-queue.test.ts` — was called by no process at all, which means a
-- worker killed mid-extraction left its job `running` forever and the creative was never
-- measured. Both are one `cron.schedule` each. Both were invisible from the suite because
-- the suite calls the function directly.

------------------------------------------------------------
-- The market's calendar day, as a function
------------------------------------------------------------
-- 0003 writes this conversion inline, and so did the first draft of the tick below. That
-- is how it stayed untested: the default is taken from `now()`, so a test can only observe
-- it at whatever o'clock the suite happens to run, and `(now())::date` under a UTC session
-- equals the market's date for eighteen hours out of every twenty-four. Measured — a
-- mutation replacing the market conversion with a bare cast survived a test written
-- specifically to catch it, because both expressions agreed at the moment it ran.
--
-- Taking the instant as a parameter moves the rule somewhere a test can hand it 05:30 UTC
-- and demand the previous day. `stable` rather than `immutable`: the answer depends on the
-- timezone database, which can be updated under a running server.
create or replace function app.market_date(at_instant timestamptz default now())
returns date
language sql
stable
set search_path = ''
as $fn$
  -- Single market by design (ARCHITECTURE.md §10.5). When a second one arrives this takes
  -- the zone from the watchlist instead of hard-coding it, and every caller keeps working.
  select (at_instant at time zone 'America/Mexico_City')::date
$fn$;

------------------------------------------------------------
-- One in-flight analysis per workspace per panel date
------------------------------------------------------------
-- The tick below guards on "no `analysis_runs` row for this panel date yet", which is the
-- right guard for a re-run *after* an analysis finished. It is not sufficient on its own:
-- between enqueueing the job and the job writing its row there is a window — minutes, if
-- the queue is busy — in which that guard still says yes. Two ticks inside the window
-- produce two jobs, two runs, and two rows for the same panel date, and the dashboard's
-- "newest run wins" read then resolves a tie between two runs that analyzed the same data.
--
-- So the real guarantee is here, as an index, per spec rule 4. `on conflict do nothing`
-- below makes the second tick a no-op rather than an error.
--
-- The predicate is over `status`, which is mutable, and that is deliberate: a row leaves
-- the index the moment it succeeds or fails. An operator re-running an analysis by hand is
-- not blocked by last night's completed job, and a permanently failed analysis is retried
-- by tomorrow's tick rather than wedging the workspace forever.
create unique index jobs_one_analysis_per_panel_date
  on public.jobs (workspace_id, (payload ->> 'panel_date'))
  where type = 'analysis' and status in ('pending', 'running');

------------------------------------------------------------
-- The analysis tick
------------------------------------------------------------
-- SECURITY DEFINER for the same reason as `app.enqueue_daily_crawls`: pg_cron runs it as
-- the job owner and it must write across every workspace. `search_path = ''` is the
-- mandatory companion (CLAUDE.md).

create or replace function app.enqueue_daily_analysis(target_date date default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_panel_date date;
  v_workspace  record;
  v_created    integer := 0;
begin
  -- The market's day, not UTC's — the same argument as 0003 and the same argument as the
  -- survival view. Through `app.market_date` so the rule has one definition and one test.
  v_panel_date := coalesce(target_date, app.market_date());

  -- Only `succeeded` counts. A `suspect` run is one whose result count fell off a cliff
  -- relative to its neighbours, and analyzing a panel that may have half-loaded produces a
  -- cohort contrast over an artifact of the crawler. `failed` is obvious. Both mean the
  -- correct action is to leave yesterday's published run standing and say nothing new,
  -- which is what enqueueing nothing achieves.
  -- `distinct` is an optimization, not the guarantee. Two watchlists in one workspace both
  -- crawling successfully would otherwise enter the loop twice, and the second insert would
  -- be absorbed by `jobs_one_analysis_per_panel_date` — same outcome, wasted round trip.
  -- Recorded because a mutation removing `distinct` survives the suite, correctly: with the
  -- index in place there is no behavior left for a test to observe.
  for v_workspace in
    select distinct cr.workspace_id
    from public.crawl_runs cr
    where cr.run_date = v_panel_date
      and cr.status = 'succeeded'
      -- Already analyzed this panel. Not a failure — the ordinary case for a manual
      -- re-run earlier in the day, or for a tick that fires twice after a platform retry.
      and not exists (
        select 1
        from public.analysis_runs ar
        where ar.workspace_id = cr.workspace_id
          and ar.panel_date = v_panel_date
      )
    order by cr.workspace_id
  loop
    insert into public.jobs (workspace_id, message_id, type, payload, trace_id, actor)
    values (
      v_workspace.workspace_id,
      app.new_ulid('msg_'),
      'analysis',
      jsonb_build_object('panel_date', v_panel_date::text),
      app.new_ulid('trc_'),
      jsonb_build_object('type', 'schedule', 'label', 'daily-analysis')
    )
    on conflict (workspace_id, (payload ->> 'panel_date'))
      where type = 'analysis' and status in ('pending', 'running')
      do nothing;

    -- `found` reflects the INSERT, so a row suppressed by the conflict clause is not
    -- counted. The return value is "jobs I created", which is what an operator reading the
    -- cron log needs; counting attempts instead would report work that did not happen.
    if found then
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end
$fn$;

revoke execute on function app.enqueue_daily_analysis(date) from public, anon, authenticated;

------------------------------------------------------------
-- Schedule
------------------------------------------------------------
-- Guarded exactly as 0003 is: pg_cron is a Supabase-managed extension that does not exist
-- in the PGlite harness, and the same migration must apply unmodified in both places or
-- the tested schema is not the deployed schema.

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- 16:00 UTC = 10:00 in Mexico City, two hours after the crawl tick. Generous for one
    -- watchlist, and cheap to widen: the analysis is milliseconds of arithmetic, so the
    -- gap is sized by how long the crawl and the extraction take, not by the analysis.
    -- If the crawl has not succeeded by then the tick enqueues nothing and yesterday's
    -- published run stands — which is the correct behavior, not a missed window.
    if not exists (select 1 from cron.job where jobname = 'mini-crux-daily-analysis') then
      perform cron.schedule(
        'mini-crux-daily-analysis',
        '0 16 * * *',
        $cron$select app.enqueue_daily_analysis()$cron$
      );
    end if;

    -- Four times an hour against a five-minute stall window: a worker that dies mid-job
    -- costs its job at most ~20 minutes of queue time. The statement is a single UPDATE
    -- over an indexed predicate, so the frequency is close to free.
    if not exists (select 1 from cron.job where jobname = 'mini-crux-reap-stalled-jobs') then
      perform cron.schedule(
        'mini-crux-reap-stalled-jobs',
        '0,15,30,45 * * * *',
        $cron$select app.reap_stalled_jobs()$cron$
      );
    end if;
  else
    raise notice 'pg_cron unavailable: analysis and reaper ticks defined but not scheduled.';
  end if;
end
$do$;
