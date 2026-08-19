-- 0013_semantic_tags_in_analysis.sql
-- Admits `has_people_on_screen` into the UC-5 contrast engine (UC-8 design §6).
--
-- Why this is a one-line change to an existing constraint and not a new table
-- -----------------------------------------------------------------------------
-- `analysis_feature_results.feature` is constrained to the values `ANALYSIS_FEATURES`
-- (`packages/analysis/src/cohorts.ts`) knows how to compute, checked against the live
-- catalog by `analysis-schema.test.ts` so the two lists cannot drift. `has_people_on_screen`
-- is boolean and runs through the exact same van Elteren + Benjamini-Hochberg pipeline as
-- `text_in_first_2s` — 0/1 in, z/p/q out — so it needs a seventh name in this list and
-- nothing else: no new column, no new statistic, no new gate.
--
-- The value itself is not stored on `creative_features` like the other six. It is read from
-- `creative_semantic_tags` (0012), a second, independently-versioned table, by the panel
-- query — see `packages/db/src/dashboard/internal.ts` (`LATEST_SEMANTIC_TAGS`) and
-- `packages/db/src/analysis/panel.ts`. That join needs no schema change: `creative_semantic_
-- tags` already carries its own RLS (0012) and this migration only widens what a *result row*
-- is allowed to name.

alter table public.analysis_feature_results
  drop constraint analysis_feature_results_feature_check;

alter table public.analysis_feature_results
  add constraint analysis_feature_results_feature_check check (feature in (
    'duration_s',
    'first_cut_time_s',
    'cuts_per_second',
    'text_in_first_2s',
    'text_density',
    'audio_energy_variance',
    'has_people_on_screen'
  ));
