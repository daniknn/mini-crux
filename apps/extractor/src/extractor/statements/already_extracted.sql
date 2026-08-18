-- Spec rule 3: never re-extract a creative already at the current feature schema version.
-- `is_stale` is part of the predicate — a row superseded by a version bump does not count
-- as current even though its version number matches an older target.
select exists (
  select 1
  from public.creative_features
  where creative_id = $1::uuid
    and schema_version = $2::integer
    and not is_stale
) as extracted
