# UC-2 — Structural feature extraction from video

**Status:** `done` · **Depends on:** UC-1 · **Blocks:** UC-4

## Goal

Turn each downloaded creative into a row of measurable structural features, locally and at zero
API cost. This is the only Python surface in the product (`apps/extractor`, Fly.io).

## Scope

**In:** video download → Storage; per-creative extraction; `creative_features` rows.

**Out:** semantic/VLM tagging (deliberately deferred — see `ARCHITECTURE.md` §10.2), any
analysis over the features (UC-5).

## Features extracted

| Feature | Method | Notes |
|---|---|---|
| `duration_s` | OpenCV | |
| `first_cut_time_s` | OpenCV frame-diff | mean abs grayscale diff over threshold |
| `cuts_per_second` | OpenCV frame-diff | total cuts / duration |
| `text_in_first_2s` | EasyOCR, frames @0.5s | hook signal, boolean |
| `text_density` | EasyOCR | fraction of sampled frames containing text |
| `first_line_transcript` | faster-whisper `tiny` | the hook line, verbatim |
| `full_transcript` | faster-whisper `tiny` | carries message-level insight for UC-4 |
| `audio_energy_variance` | librosa RMS | pacing/intensity proxy |

`full_transcript` is an addition beyond the reference implementation. With semantic tagging out
of scope, the transcript plus the Ad Library ad copy is the *only* route to message-level
insight — it is what keeps UC-4 from being purely geometric.

## Rules

1. **Degrade gracefully.** A static-image ad, a missing audio track, or an OCR failure yields
   `null` for that feature and an entry in `skipped_features[]` — never a failed job.
2. **Checkpoint per creative.** A crash loses at most one creative's work.
3. **Extract once per `creative_hash`.** Features are a property of the creative, not of the
   observation or the ad. Never re-extract for a creative already at the current
   `feature_schema_version`.
4. **Version the feature set.** `creative_features.schema_version` — adding or changing a
   feature bumps it and marks prior rows stale rather than silently mixing definitions.
5. **Blocking work runs in a real thread pool.** OpenCV / EasyOCR / whisper / librosa are
   synchronous and CPU-heavy. Running them inside an `async def` starves the event loop and
   silently prevents job heartbeats from being transmitted — the failure presents as a spurious
   timeout on a job that is in fact progressing. Use a `ThreadPoolExecutor`.
6. **Cap the work.** Videos over a configured duration are truncated for OCR/transcription
   sampling, not skipped; the cap is recorded on the row.

## Acceptance criteria

- [x] A 15s MP4 yields a complete `creative_features` row
- [x] A static-image creative yields a row with nulls and a populated `skipped_features[]`
- [x] A corrupt/unreachable media file marks the job failed with a reason, and does not block
      the other creatives in the batch
- [x] Re-running extraction for an already-extracted `creative_hash` at the same
      `schema_version` is a no-op
- [x] Bumping `schema_version` marks existing rows stale and re-enqueues them
- [x] Long-running extraction heartbeats correctly and is not killed as a false timeout

## Test plan

| What to test | Steps | Expected |
|---|---|---|
| Happy path | extract a known fixture video | cuts/OCR/transcript/energy all populated |
| Graceful degradation | extract a silent video | `audio_energy_variance` null, listed in `skipped_features` |
| Idempotency | run extraction twice | second run is a no-op |
| Versioning | bump `schema_version`, re-run | prior rows stale, re-extraction enqueued |
| Throughput | batch of 50 creatives, kill worker mid-batch, restart | completed creatives not redone |

**Quick CLI check:**
```bash
doppler run -- python -m extractor.run --creative <hash>
psql -c "select count(*), count(first_cut_time_s), count(full_transcript)
         from creative_features where schema_version = 1;"
```

## Notes

Feature *definitions* are load-bearing for UC-5 and must not drift silently. Any change to a
threshold (cut-detection sensitivity, OCR confidence floor, hook window) is a `schema_version`
bump, because it changes what the numbers mean and therefore what the analysis concludes.

### What the tests caught

150 tests (54 Python · 96 TypeScript) passed, which by itself is worth very little here — a
feature extractor that silently measures the *wrong* quantity still returns a full row and a
green suite. So the load-bearing behavior was checked by mutating the source and confirming a
specific test went red. 16 mutants, 14 killed on the first pass:

| Mutation | Test that failed |
|---|---|
| reconciler ignores `status = 'running'` jobs | does not stack a second job while the first is running |
| `mark_features_stale` uses `<=` | leaves rows at or above the target version current |
| `claim_job` drops the type filter | ignores job types it was not asked for |
| `claim_job` overwrites `started_at` | preserves the original `started_at` across a retry |
| reconciler ignores `media_url is not null` | skips creatives with no media url |
| `HOOK_WINDOW_S` 2.0 → 3.0 | definitions digest · text after the hook window |
| `OCR_MIN_CONFIDENCE` → 0.0 | definitions digest · low-confidence detections discarded |
| `CUT_DIFF_THRESHOLD` 12.0 → 2.0 | definitions digest |
| image path zeroes time features instead of skipping | image degradation |
| silent track recorded as a skip instead of `""` | music-only transcript |
| permanent failure downgraded to a retry | corrupt file fails without blocking the batch |
| `already_extracted` check removed | idempotency |
| media path keyed on the rotating URL | 5 tests across pathing and landing |

**Two survivors, both real gaps, both now closed:**

1. **`cuts_per_second` divided by full duration instead of the analyzed span.** The truncation
   test asserted `cuts_per_second > 0`, which is true under the bug. On a 5s ad sampled to 2s
   the correct rate is 1.0/s and the bug reports 0.4/s — every long creative's cut rate biased
   downward by exactly its truncation ratio, with a fully populated row and a green suite. The
   assertion is now the exact value.
2. **`DEFAULT_HEARTBEAT_INTERVAL_S` could be raised without any test noticing.** The liveness
   test passes an explicit interval, so it proved the mechanism but never the shipped constant
   — which is only meaningful relative to `app.reap_stalled_jobs`' stall window, a number in
   another language in another directory. Raising it to 3600s left the suite green while
   guaranteeing every healthy extraction gets reaped mid-flight, which is rule 5's failure mode
   reintroduced by a one-line edit. There is now an invariant test that reads the window out of
   `0004_features.sql` and requires 10× headroom.

A third mutant (deleting the `heartbeat_at is not null` guard in the reaper) survived and was
**correctly** left alive: `null < now() - interval` is null, so SQL's three-valued logic already
excludes the row. The clause is redundant-but-explicit, and the test asserts the behavior rather
than the mechanism, so it holds whichever of the two someone edits away.

### What is not covered

The `ml` extra (easyocr, faster-whisper, librosa) is **not installed in CI** — it pulls ~2GB of
torch and would make the fastest job the slowest. The pipeline is tested against fake backends
that honor the same protocols, so CI proves the orchestration, the degradation paths and the
thresholds, but **not** the models themselves. Their dependencies *are* audited (`--all-extras`),
since they ship to Fly.io even though they never run in CI.

Similarly, the Python worker's SQL is never executed by pytest. It is `PREPARE`d against a real
migrated PGlite in `packages/db/test/worker-sql.test.ts`, which validates every table, column
and cast against the schema the migrations actually produce, but does not prove runtime
semantics. `MemoryJobStore` covers the semantics with none of the syntax; the two halves meet
only at review.
