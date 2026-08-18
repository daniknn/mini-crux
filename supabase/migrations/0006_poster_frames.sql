-- 0006_poster_frames.sql
-- Poster frames for the creative gallery (UC-4).
--
-- Why a stored poster and not Meta's media_url
-- --------------------------------------------
-- `creatives.media_url` is a signed Ad Library URL. It rotates between crawls and expires,
-- which is the same property that makes it unusable as a creative identity (CLAUDE.md,
-- panel guardrails). Rendering a gallery from it produces a wall of broken images some
-- number of hours after the crawl, with nothing in the schema to indicate why. The poster
-- is derived from the bytes UC-2 already downloaded and stored, so it lives exactly as long
-- as the rest of the evidence does.
--
-- Why it belongs on creative_features and not on creatives
-- --------------------------------------------------------
-- The poster is a product of the extractor run, not of the crawl: it is cut from
-- `media_storage_path`, it is versioned by the same `schema_version`, and when a newer
-- definition set supersedes a feature row the poster it produced is superseded with it.
-- Putting it on `creatives` would leave a v1 poster pointing at a row marked `is_stale`,
-- and the gallery would show the old frame beside the new measurements.
--
-- Why it is nullable and why that is not a defect
-- -----------------------------------------------
-- Poster extraction is best-effort (spec rule: "never fails the job"). A creative whose
-- media will not decode still deserves its feature row and its place in the panel, so a
-- null here means "no frame", the reason lands in `skipped_features`, and the gallery
-- renders a text card. This is the same three-kinds-of-null discipline as every other
-- feature: absent-but-attempted is null with a skip entry, never a zero and never a
-- missing row.

alter table public.creative_features
  add column poster_storage_path text;

comment on column public.creative_features.poster_storage_path is
  'Storage key of a keyframe JPEG cut from media_storage_path, or null when extraction was '
  'skipped (see skipped_features). Served to the browser only through a short-lived signed '
  'URL minted server-side — the bucket is private.';

-- Partial: the gallery asks "which of these creatives has a poster", and the answer for a
-- healthy panel is most of them, so the index only needs to carry the ones that do.
create index creative_features_poster_idx
  on public.creative_features (creative_id)
  where poster_storage_path is not null and not is_stale;

-- No new policy. `creative_features` already carries workspace_id with tenant read/write
-- policies from 0004, and a column addition inherits them. Called out because "new column,
-- no policy change" and "new table, forgot the policy" look identical in a diff.
