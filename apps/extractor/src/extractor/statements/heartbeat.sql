-- "Still alive." Guarded on status so a heartbeat racing a completion cannot resurrect a
-- finished job into the reaper's view.
update public.jobs
set heartbeat_at = now()
where id = $1::uuid
  and status = 'running'
