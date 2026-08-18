-- Retry until attempts are exhausted, then stop. `run_after` carries the backoff, so a
-- creative whose media reliably kills the extractor drifts to the back of the queue
-- instead of monopolising the worker — spec acceptance criterion 3: one bad file must not
-- block the rest of the batch.
update public.jobs
set status      = (case when attempts >= max_attempts then 'failed' else 'pending' end)::job_status,
    last_error  = $2::text,
    run_after   = now() + make_interval(secs => $3::double precision),
    finished_at = case when attempts >= max_attempts then now() else null end,
    heartbeat_at = null
where id = $1::uuid
