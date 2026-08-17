-- 0001_foundation.sql
-- Tenancy, identity, the job queue, idempotency, and the audit log.
--
-- Tenancy model
-- -------------
-- The tenant is a Clerk Organization. `workspaces` is a thin projection of it
-- (`workspaces.clerk_org_id`), synced by the Clerk webhook. The active org comes from
-- the session JWT, never from a URL. RLS resolves it via app.current_workspace_id().
--
-- RLS testing note (learned the hard way — see CLAUDE.md)
-- ------------------------------------------------------
-- Superusers and BYPASSRLS roles ALWAYS bypass RLS, even with FORCE ROW LEVEL SECURITY.
-- Any test asserting isolation MUST `set role authenticated` first, or it will pass
-- vacuously while proving nothing.

------------------------------------------------------------
-- Roles
------------------------------------------------------------
-- Supabase provisions these; PGlite (used by the test harness) does not. Created
-- conditionally so the same migration runs unmodified in both.

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

------------------------------------------------------------
-- Helper schema
------------------------------------------------------------
-- Helpers live outside `public` so PostgREST never exposes them as API endpoints.
--
-- ORDERING: only the table-independent helpers go here. Postgres validates the body of a
-- `language sql` function at CREATE time (`check_function_bodies`), so a helper that reads
-- `public.workspaces` cannot be defined before that table exists. Those helpers are defined
-- immediately after the table they read, further down.

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- Reads a single claim from the request JWT. Supabase populates
-- `request.jwt.claims`; the test harness sets the same GUC directly.
create or replace function app.jwt_claim(claim text)
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> claim
$$;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

------------------------------------------------------------
-- schema_migrations (tracking table for the auto-runner)
------------------------------------------------------------

create table if not exists public.schema_migrations (
  version     text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now()
);

-- Infrastructure, not tenant data: no client role may read or write it.
-- RLS is enabled with no permissive policy, which denies everything by default.
-- The migration runner connects with a BYPASSRLS role.
alter table public.schema_migrations enable row level security;

create policy schema_migrations_no_client_access on public.schema_migrations
  for all to anon, authenticated
  using (false);

------------------------------------------------------------
-- Identity
------------------------------------------------------------

create table public.app_users (
  id            uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  email         text,
  full_name     text,
  image_url     text,
  locale        text not null default 'es-MX',
  timezone      text not null default 'America/Mexico_City',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index app_users_email_lower_idx on public.app_users (lower(email))
  where email is not null;

create trigger app_users_set_updated_at
  before update on public.app_users
  for each row execute function app.set_updated_at();

-- Defined here, not in the helper block above: its body reads `public.app_users`.
--
-- SECURITY DEFINER is load-bearing, not a shortcut. `app_users` has an RLS policy, and
-- that policy is re-applied to any query inside a policy expression — an INVOKER function
-- reading the same table it guards recurses until Postgres aborts with
-- ERRORDATA_STACK_SIZE. Running as the owner breaks the cycle. `search_path = ''` is the
-- required companion: it stops a caller-controlled search_path from resolving these
-- unqualified-looking names to attacker tables.
create or replace function app.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.app_users u
  where u.clerk_user_id = app.jwt_claim('sub')
$$;

alter table public.app_users enable row level security;

create policy app_users_self_read on public.app_users
  for select to authenticated
  using (clerk_user_id = app.jwt_claim('sub'));

create policy app_users_self_update on public.app_users
  for update to authenticated
  using (clerk_user_id = app.jwt_claim('sub'))
  with check (clerk_user_id = app.jwt_claim('sub'));

------------------------------------------------------------
-- Tenancy
------------------------------------------------------------

create table public.workspaces (
  id            uuid primary key default gen_random_uuid(),
  clerk_org_id  text not null unique,
  slug          text not null unique,
  name          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function app.set_updated_at();

-- The active workspace, resolved from the Clerk org id in the JWT. Defined here, not in
-- the helper block above: its body reads `public.workspaces`.
--
-- STABLE so the planner evaluates it once per statement rather than per row.
-- SECURITY DEFINER for the same reason as app.current_user_id() above: this function is
-- called from the RLS policy on `workspaces` itself, so an INVOKER version recurses.
create or replace function app.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id
  from public.workspaces w
  where w.clerk_org_id = app.jwt_claim('org_id')
$$;

alter table public.workspaces enable row level security;

create policy workspaces_member_read on public.workspaces
  for select to authenticated
  using (id = app.current_workspace_id());

create type workspace_role as enum ('owner', 'admin', 'member', 'viewer');

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.app_users(id) on delete cascade,
  role         workspace_role not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

alter table public.workspace_members enable row level security;

create policy workspace_members_tenant_read on public.workspace_members
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Job queue
------------------------------------------------------------
-- Every async operation is a job row (CLAUDE.md rule 9). `message_id` is a ULID
-- minted by the enqueuer and is the idempotency key: the unique constraint is what
-- actually makes redelivery safe, not application-level checking.

create type job_status as enum ('pending', 'running', 'succeeded', 'failed');

create table public.jobs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  message_id     text not null unique,
  type           text not null,
  payload        jsonb not null default '{}',
  schema_version integer not null default 1,
  status         job_status not null default 'pending',
  attempts       integer not null default 0,
  max_attempts   integer not null default 3,
  run_after      timestamptz not null default now(),
  trace_id       text not null,
  actor          jsonb not null,
  last_error     text,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

-- Claim path: pending jobs that are due, oldest first.
create index jobs_claimable_idx on public.jobs (run_after)
  where status = 'pending';
create index jobs_workspace_idx on public.jobs (workspace_id, created_at desc);
create index jobs_trace_idx on public.jobs (trace_id);

alter table public.jobs enable row level security;

-- Clients may observe their own jobs; only the worker (service_role, BYPASSRLS)
-- writes to them.
create policy jobs_tenant_read on public.jobs
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Idempotency ledger
------------------------------------------------------------
-- Written in the SAME transaction as the side effect it guards. The primary key is
-- the enforcement mechanism: a second delivery hits a unique violation and rolls back.

create table public.processed_messages (
  message_id   text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id       uuid references public.jobs(id) on delete set null,
  trace_id     text not null,
  processed_at timestamptz not null default now()
);

create index processed_messages_workspace_idx on public.processed_messages (workspace_id);

alter table public.processed_messages enable row level security;

create policy processed_messages_tenant_read on public.processed_messages
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Audit log (append-only)
------------------------------------------------------------
-- Queryable by actor / trace_id / type / date (DashOne §3). Append-only is enforced
-- structurally: there is no update or delete policy, and the privilege is revoked
-- outright so even a future permissive policy cannot re-open it.

create table public.audit_events (
  id             bigserial primary key,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  trace_id       text not null,
  actor          jsonb not null,
  type           text not null,
  subject_type   text,
  subject_id     text,
  payload        jsonb not null default '{}',
  schema_version integer not null default 1,
  created_at     timestamptz not null default now()
);

create index audit_events_workspace_created_idx on public.audit_events (workspace_id, created_at desc);
create index audit_events_trace_idx on public.audit_events (trace_id);
create index audit_events_type_idx on public.audit_events (workspace_id, type, created_at desc);
create index audit_events_actor_idx on public.audit_events using gin (actor);

alter table public.audit_events enable row level security;

create policy audit_events_tenant_read on public.audit_events
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

-- Append is allowed, but only into the caller's own workspace. Without this policy the
-- `insert` grant below would be dead: RLS denies any command that has no permissive
-- policy, so a select-only policy set makes the table read-only regardless of grants.
create policy audit_events_tenant_append on public.audit_events
  for insert to authenticated
  with check (workspace_id = app.current_workspace_id());

revoke update, delete on public.audit_events from anon, authenticated, service_role;

------------------------------------------------------------
-- Grants
------------------------------------------------------------
-- RLS narrows rows; grants narrow tables. Both are required — RLS on a table with no
-- grant is unreachable, and a grant with no RLS is a tenancy leak.

grant usage on schema public to anon, authenticated, service_role;

grant select                         on public.workspaces         to authenticated;
grant select                         on public.workspace_members  to authenticated;
grant select, update                 on public.app_users          to authenticated;
grant select                         on public.jobs               to authenticated;
grant select                         on public.processed_messages to authenticated;
grant select, insert                 on public.audit_events       to authenticated;
grant usage, select                  on sequence public.audit_events_id_seq to authenticated;
