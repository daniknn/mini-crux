-- For failures that retrying cannot fix: the creative is gone, it has no media URL, or the
-- bytes do not decode. Burning the remaining attempts on those would put a file that will
-- never work back at the head of a queue ordered by `run_after`, ahead of creatives that
-- would extract fine. So it stops on the first attempt, with the reason recorded.
update public.jobs
set status       = 'failed',
    last_error   = $2::text,
    finished_at  = now(),
    heartbeat_at = null
where id = $1::uuid
