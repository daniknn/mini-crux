-- Upsert on (creative_id, schema_version). Not a plain insert: a re-delivered job or a
-- reaped-then-retried one must converge on one row per version rather than collide.
--
-- `is_stale = false` on conflict is deliberate. Re-extracting at a version that was
-- previously marked stale is exactly how a version bump is serviced, and leaving the flag
-- set would make the fresh measurement present as superseded.
insert into public.creative_features (
  workspace_id, creative_id, schema_version,
  media_storage_path, media_sha256, media_bytes,
  duration_s, first_cut_time_s, cuts_per_second,
  text_in_first_2s, text_density,
  first_line_transcript, full_transcript, audio_energy_variance,
  analysis_cap_s, truncated, skipped_features,
  extractor_version, trace_id, extracted_at
)
values (
  $1::uuid, $2::uuid, $3::integer,
  $4::text, $5::text, $6::bigint,
  $7::numeric, $8::numeric, $9::numeric,
  $10::boolean, $11::numeric,
  $12::text, $13::text, $14::double precision,
  $15::numeric, $16::boolean, $17::text[],
  $18::text, $19::text, now()
)
on conflict (creative_id, schema_version) do update
set media_storage_path    = excluded.media_storage_path,
    media_sha256          = excluded.media_sha256,
    media_bytes           = excluded.media_bytes,
    duration_s            = excluded.duration_s,
    first_cut_time_s      = excluded.first_cut_time_s,
    cuts_per_second       = excluded.cuts_per_second,
    text_in_first_2s      = excluded.text_in_first_2s,
    text_density          = excluded.text_density,
    first_line_transcript = excluded.first_line_transcript,
    full_transcript       = excluded.full_transcript,
    audio_energy_variance = excluded.audio_energy_variance,
    analysis_cap_s        = excluded.analysis_cap_s,
    truncated             = excluded.truncated,
    skipped_features      = excluded.skipped_features,
    extractor_version     = excluded.extractor_version,
    trace_id              = excluded.trace_id,
    extracted_at          = excluded.extracted_at,
    is_stale              = false
