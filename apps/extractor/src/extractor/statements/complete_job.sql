update public.jobs
set status       = 'succeeded',
    finished_at  = now(),
    heartbeat_at = null,
    last_error   = null
where id = $1::uuid
