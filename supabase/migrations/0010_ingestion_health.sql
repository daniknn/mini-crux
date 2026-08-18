------------------------------------------------------------
-- Ingestion health: is today's crawl in?
------------------------------------------------------------
-- The alarm is the feature.
--
-- A crawl that FAILS is survivable: it is loud, `crawl_runs.status` says so, and an operator
-- who retries before midnight in the market keeps the panel date. A crawl that NEVER RAN is
-- the one that costs data permanently, and it is silent by construction — no row is written,
-- no error is raised, nothing anywhere changes colour. `pg_cron` not firing, a watchlist
-- created after the tick, a worker that is up but claiming nothing: all of them look exactly
-- like a quiet morning.
--
-- So this view's central job is to make "no row" into a value. `never-started` is a state
-- with a name, sitting in the same column as `failed`, because the two demand different
-- responses and an operator paged at 09:00 needs to know which one they have before they open
-- anything else.

------------------------------------------------------------
-- The view
------------------------------------------------------------
-- `security_invoker = true` is load-bearing — see the note above `creative_survival` in 0005.
-- Here it does double duty and is the reason this is a view rather than a `security definer`
-- function:
--
--   * The dashboard reads it inside `withTenant` as `authenticated`, so RLS on `watchlists`
--     and `crawl_runs` filters it to the operator's own workspace. Labels and queries are
--     that workspace's own competitors, and it is right that they are visible there.
--   * The uptime endpoint reads it as `service_role`, which is BYPASSRLS, and therefore sees
--     every workspace. That is what a whole-instance alarm requires.
--
-- One definition, two callers, no second implementation to drift. A `security definer`
-- function would have had to choose one of those audiences and lie to the other.
create view public.ingestion_health
with (security_invoker = true) as
select
  w.workspace_id,
  w.id                              as watchlist_id,
  w.label,
  w.query,
  w.country,
  -- The market's calendar day, never the reader's. A monitor in Frankfurt and an operator in
  -- Mexico City must agree on which day is "today", or the alarm fires for six hours every
  -- night on a panel that is perfectly healthy. See `app.market_date` in 0009.
  --
  -- Emitted as `text`, not as `date`, and that is not a detail. Every driver invents its own
  -- instant for a bare `date`: node-postgres builds a `Date` at the *reader's* local
  -- midnight, PGlite builds one at UTC midnight, PostgREST sends a plain string. Read the
  -- first two back with the wrong assumption and the day shifts by one — which is exactly
  -- the failure this column exists to prevent, arriving through the client library instead
  -- of through the SQL. A day with no instant cannot be shifted by anybody.
  app.market_date()::text           as market_date,
  -- The whole point of the view. `left join` + `coalesce` turns the absence of a row into a
  -- state, so "we never looked" is a value an alarm can read rather than an empty result an
  -- alarm silently agrees with.
  coalesce(r.status::text, 'never-started') as state,
  r.id                              as crawl_run_id,
  r.attempt,
  r.error,
  r.started_at,
  r.finished_at
from public.watchlists w
left join public.crawl_runs r
  on r.watchlist_id = w.id
 and r.run_date = app.market_date()
-- Inactive watchlists are not a failure to crawl, they are a decision not to. Paging someone
-- about one is how an alarm gets muted, and a muted alarm is worse than no alarm.
where w.is_active;

comment on view public.ingestion_health is
  'One row per active watchlist with today''s market-date crawl state. `never-started` is a '
  'state, not an absence — that distinction is the entire alarm.';

-- Supabase''s bootstrap grants this by default; PGlite has no bootstrap, so the grant has to
-- be explicit or every test that reads the view as `authenticated` fails on privileges rather
-- than on policy. `service_role` needs no grant: it is BYPASSRLS and holds the table rights
-- already.
grant select on public.ingestion_health to authenticated;
