-- 0005_survival.sql
-- Survival derivation with censoring (UC-3).
--
-- What this migration is protecting
-- ---------------------------------
-- This is the outcome variable. Everything the product concludes is a statement about
-- `days_active`, and every way of getting it wrong produces a confident, well-formatted,
-- entirely inverted answer. The three that matter:
--
-- 1. Right-censoring. A creative still running has an unknown end date, so `days_active` is
--    a *lower bound*, not a duration. The creatives still running are disproportionately
--    the good ones — that is why they are still running — so treating the bound as a
--    measurement systematically underestimates exactly the winners the product exists to
--    find. `is_censored` travels with `days_active` everywhere, and CLAUDE.md rule 6 bans
--    naive correlation over the latter.
--
-- 2. Left-censoring, which Meta solves for free. `ad_delivery_start_time` is the true start
--    even for ads that predate our first crawl. Substituting `first_seen_at` would silently
--    truncate the age of every pre-existing ad — and the longest-running ads are the most
--    likely to predate us, so the bias again lands hardest on the winners.
--
-- 3. Inferred death. An absence is only evidence if we actually looked. Observations from
--    `suspect` and `failed` crawls are excluded here as well as at write time, so a bad
--    crawl day cannot manufacture a death.
--
-- Why every date here comes from `run_date`
-- -----------------------------------------
-- `observed_at` is a timestamptz — an instant. Casting one to a date applies the *reader's*
-- session timezone, so `observed_at::date` is not a fact about the crawl, it is a fact about
-- who is asking. A crawl that runs at 20:00 in Mexico City is 02:00 UTC the next day: read
-- through the Supabase API (UTC) that observation lands on a different calendar day than it
-- does from an operator's local psql, and `days_active` comes back one larger. Measured on
-- the fixture in `packages/db/test/survival.test.ts`, one identical panel yields 30 days in
-- America/Mexico_City and 31 in UTC, with `observation_days` differing too. Nothing errors —
-- the outcome variable just quietly depends on the connection that read it.
--
-- `crawl_runs.run_date` exists precisely to avoid this: it is the crawl's logical day in the
-- watchlist's market, resolved once at write time. Every date below is derived from it. The
-- timestamps are still exposed, because an instant is unambiguous and useful for display, but
-- nothing is *computed* from them.
--
-- Why a plain view and not a materialized one
-- -------------------------------------------
-- Rule 4 requires recomputation to be pure — the panel is append-only, so survival must be
-- derivable from it at any time. A plain view is that property made structural: there is no
-- refresh to forget, no staleness window, and "drop and rebuild reproduces identical rows"
-- is true by construction rather than by discipline. If this becomes slow, the upgrade is a
-- materialized view refreshed at the end of each crawl — but it should be made slow first,
-- with a panel big enough to prove it, rather than pre-optimized into a staleness bug.

------------------------------------------------------------
-- Creative survival
------------------------------------------------------------
-- `security_invoker = true` is load-bearing, not boilerplate.
--
-- A Postgres view executes with the privileges of its OWNER by default. The owner here is
-- the migration role, which bypasses RLS — so a view defined the ordinary way over
-- `creative_observations` would happily return every workspace's panel to any authenticated
-- caller, while each underlying table still reports its policy as enabled and the tenancy
-- tests on those tables still pass. It is a cross-tenant leak that looks exactly like a
-- correctly secured system from every angle except an actual cross-workspace query.
--
-- With `security_invoker`, the view runs as the caller and the base-table policies apply.
-- `scripts/check-rls-policies.mjs` now fails any public view that omits it, and
-- `packages/db/test/rls.test.ts` proves the isolation against a live catalog.

create view public.creative_survival
with (security_invoker = true) as

-- Only healthy crawls are evidence. A `suspect` run withheld its absences at write time and
-- a `failed` run wrote nothing at all; excluding them again here means a future writer bug
-- cannot turn a bad crawl day into a wave of deaths.
with healthy_runs as (
  select id, workspace_id, watchlist_id, run_date
  from public.crawl_runs
  where status = 'succeeded'
),

observations as (
  select o.creative_id,
         o.workspace_id,
         o.observed_at,
         o.is_present,
         r.watchlist_id,
         r.run_date
  from public.creative_observations o
  join healthy_runs r on r.id = o.crawl_run_id
),

-- The watchlists that have ever observed this creative. A creative can be picked up by more
-- than one, and "could we have seen it that day?" is a question about all of them: a gap in
-- one watchlist is not a gap in coverage if another was crawling healthily.
coverage as (
  select distinct creative_id, watchlist_id
  from observations
),

-- The instants are for display; the dates are what the arithmetic runs on.
presence as (
  select creative_id,
         min(observed_at) filter (where is_present) as first_seen_at,
         max(observed_at) filter (where is_present) as last_seen_at,
         min(run_date)    filter (where is_present) as first_seen_date,
         max(run_date)    filter (where is_present) as last_seen_date
  from observations
  group by creative_id
  having count(*) filter (where is_present) > 0
),

-- Death requires evidence (rule 3): the earliest recorded absence on a crawl day *after* the
-- last day the creative was confirmed present. An absence on or before that day is a crawl
-- that missed it, not a death — the creative demonstrably came back.
--
-- `distinct on` rather than two independent aggregates: `stopped_date` and `stopped_at` must
-- describe the same observation. Taking min() of each separately would let them be sourced
-- from different rows, reporting a death date and a death instant that disagree.
stopped as (
  select distinct on (o.creative_id)
         o.creative_id,
         o.run_date    as stopped_date,
         o.observed_at as stopped_at
  from observations o
  join presence p on p.creative_id = o.creative_id
  where o.is_present = false
    and o.run_date > p.last_seen_date
  order by o.creative_id, o.run_date, o.observed_at
),

-- The most recent day we could have seen this creative at all. For a censored creative this
-- is the end of its observed span: it was still running as of this date.
last_look as (
  select c.creative_id,
         max(r.run_date) as last_crawl_date
  from coverage c
  join healthy_runs r on r.watchlist_id = c.watchlist_id
  group by c.creative_id
),

spans as (
  select p.creative_id,
         p.first_seen_at,
         p.last_seen_at,
         p.first_seen_date,
         s.stopped_at,
         l.last_crawl_date,
         coalesce(s.stopped_date, l.last_crawl_date) as end_date
  from presence p
  join last_look l on l.creative_id = p.creative_id
  left join stopped s on s.creative_id = p.creative_id
),

-- Days on which a covering watchlist ran healthily inside the creative's span: how many
-- chances we actually had to see it. A `days_active` of 30 built from 3 crawls is a much
-- weaker measurement than one built from 30, and the consumer has to be able to tell.
observation_days as (
  select sp.creative_id,
         count(distinct r.run_date) as observation_days
  from spans sp
  join coverage c on c.creative_id = sp.creative_id
  join healthy_runs r on r.watchlist_id = c.watchlist_id
  where r.run_date between sp.first_seen_date and sp.end_date
  group by sp.creative_id
),

-- Every day inside the span, collapsed across all the watchlists covering this creative.
-- Grouping by day is what lets `gaps` below ask its question per day rather than per run.
span_days as (
  select sp.creative_id,
         r.run_date,
         bool_or(r.status = 'succeeded')            as any_healthy,
         bool_or(r.status in ('suspect', 'failed')) as any_bad
  from spans sp
  join coverage c on c.creative_id = sp.creative_id
  join public.crawl_runs r on r.watchlist_id = c.watchlist_id
  where r.run_date between sp.first_seen_date and sp.end_date
  group by sp.creative_id, r.run_date
),

-- A day whose history we cannot recover: a covering watchlist produced a failed or suspect
-- crawl and no other covering watchlist produced a healthy one that day. Flagged so the row
-- is excluded from analysis cohorts by default (rule 2).
--
-- Deliberately not "any covering watchlist failed that day". A creative picked up by two
-- watchlists is still fully observed if the second crawled healthily — `coverage` above says
-- as much — and flagging it would discard a creative whose history we actually hold. For the
-- single-watchlist case, which is nearly all of them, the two definitions coincide.
gaps as (
  select creative_id,
         bool_or(any_bad and not any_healthy) as has_gaps
  from span_days
  group by creative_id
)

select cr.id                as creative_id,
       cr.workspace_id,
       cr.advertiser_id,
       cr.creative_hash,
       cr.media_type,

       -- Meta's start date, and only Meta's. Never `first_seen_at` (CLAUDE.md rule 5).
       cr.ad_delivery_start_time as started_at,
       sp.first_seen_at,
       sp.last_seen_at,
       sp.stopped_at,
       sp.last_crawl_date,

       -- The right edge of the measurement: the death day, or the last day we looked. Exposed
       -- so `days_active` can be audited without re-deriving it.
       sp.end_date,

       -- Null rather than a guess when Meta gave us no start date. The tempting fallback is
       -- `first_seen_at`, which is precisely the left-censoring bug: it would report a
       -- two-year-old ad we met last week as seven days old. A null forces the consumer to
       -- exclude the creative, which is the correct handling of "we cannot measure this".
       --
       -- The `at time zone` is the one place an instant becomes a date here, and it resolves
       -- Meta's start onto the same calendar `end_date` is struck on. Casting it in the
       -- session zone instead would subtract two dates read off different clocks — and would
       -- move with whoever ran the query. The literal is safe because the product is scoped to
       -- a single market (ARCHITECTURE.md §10.5, `watchlists.country` defaults to 'MX'); a
       -- second market makes this a join to the watchlist's country, not a second cast.
       case
         when cr.ad_delivery_start_time is null then null
         else (sp.end_date
                 - (cr.ad_delivery_start_time at time zone 'America/Mexico_City')::date)
       end as days_active,

       -- Still running at the last healthy look, so `days_active` is a lower bound.
       (sp.stopped_at is null) as is_censored,

       coalesce(od.observation_days, 0) as observation_days,
       coalesce(g.has_gaps, false)      as has_gaps
from spans sp
join public.creatives cr on cr.id = sp.creative_id
left join observation_days od on od.creative_id = sp.creative_id
left join gaps g on g.creative_id = sp.creative_id;

comment on view public.creative_survival is
  'Per-creative duration with explicit right-censoring. days_active is a LOWER BOUND when '
  'is_censored is true; never correlate over it without carrying is_censored (CLAUDE.md '
  'rule 6). Rows with has_gaps span a failed or suspect crawl and are excluded from '
  'analysis cohorts by default.';

grant select on public.creative_survival to authenticated;
