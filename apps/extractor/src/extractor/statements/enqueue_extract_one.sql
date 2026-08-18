-- Enqueues a single extract job on behalf of an operator running `--creative <id>`.
--
-- Deliberately not a separate extraction path. The CLI enqueues and then drains the queue,
-- so the debugging command exercises the same code that runs in production — two paths to
-- the same outcome would eventually disagree, and the one that matters is the job path.
--
-- The actor is `operator` rather than `schedule`: when this row shows up in the audit log
-- months later, "a human asked for this creative by hand" is the fact worth recovering.
insert into public.jobs
     (workspace_id, message_id, type, payload, trace_id, actor)
   values ($1, $2, 'extract', jsonb_build_object(
     'creative_id', $3::uuid, 'schema_version', $4::integer
   ), $5, jsonb_build_object(
     'type', 'operator', 'id', 'cli', 'label', 'extract-one'
   ))
