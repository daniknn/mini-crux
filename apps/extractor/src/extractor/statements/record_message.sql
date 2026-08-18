-- The idempotency ledger. Written in the SAME transaction as the features row, so a
-- redelivered message hits the primary key and rolls back both — DashOne §3.
insert into public.processed_messages (message_id, workspace_id, job_id, trace_id)
values ($1::text, $2::uuid, $3::uuid, $4::text)
