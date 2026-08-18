-- Claim one due job. Zero rows means the queue is empty; see app.claim_job for why this
-- is SETOF and not a composite.
select id, workspace_id, message_id, type, payload, trace_id, actor, attempts, max_attempts
from app.claim_job($1::text[])
