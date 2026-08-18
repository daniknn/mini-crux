insert into public.audit_events (
  workspace_id, trace_id, actor, type, subject_type, subject_id, payload
)
values ($1::uuid, $2::text, $3::jsonb, $4::text, $5::text, $6::text, $7::jsonb)
