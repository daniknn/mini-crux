# UC-2 — Structural feature extraction from video

**Status:** `todo` · **Depends on:** UC-1 · **Blocks:** UC-4

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

- [ ] A 15s MP4 yields a complete `creative_features` row
- [ ] A static-image creative yields a row with nulls and a populated `skipped_features[]`
- [ ] A corrupt/unreachable media file marks the job failed with a reason, and does not block
      the other creatives in the batch
- [ ] Re-running extraction for an already-extracted `creative_hash` at the same
      `schema_version` is a no-op
- [ ] Bumping `schema_version` marks existing rows stale and re-enqueues them
- [ ] Long-running extraction heartbeats correctly and is not killed as a false timeout

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
