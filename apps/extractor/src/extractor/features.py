"""Feature definitions: the thresholds, the schema version, and the row shape.

Why this module is small and loud
---------------------------------
Everything here is a *definition*, and definitions are load-bearing for the cohort
analysis in UC-5. `cuts_per_second` computed with a frame-diff threshold of 12 is not the
same quantity as one computed with a threshold of 25 — but both are plausible numbers, both
pass every test, and mixing them across rows silently changes what the product concludes.

So the thresholds live in exactly one place, and `definitions_digest()` hashes them. A test
pins that digest. Changing a threshold without bumping `FEATURE_SCHEMA_VERSION` therefore
fails the suite instead of quietly corrupting the analysis — see
`tests/test_feature_definitions.py`.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, fields
from typing import Any

# Bump this whenever any threshold below changes, or a feature is added or removed.
# `app.mark_features_stale()` then marks prior rows stale and the reconciler re-extracts.
#
# v2 adds the poster frame (UC-4). The bump is not ceremony: every v1 row has no poster, and
# a bump is the only mechanism that gets one — the reconciler re-reads the media UC-2 landed
# immutably, which is exactly why the bytes were kept rather than the signed URL.
FEATURE_SCHEMA_VERSION = 2

# --- Cut detection -----------------------------------------------------------------
# Frames are converted to grayscale and downscaled before differencing, so the threshold
# is in 0-255 units of mean absolute per-pixel change. 12 is deliberately conservative:
# it treats a hard cut as a cut and lets a fast pan or a whip transition pass. Under-
# counting cuts biases `cuts_per_second` low uniformly, which a cohort contrast tolerates;
# over-counting would make every handheld ad look like a rapid-cut ad, which it does not.
CUT_DIFF_THRESHOLD = 12.0
# Analysis resolution for differencing. Small on purpose — cut detection is a global
# brightness/composition change, and downscaling suppresses sensor noise and compression
# artefacts that would otherwise trip the threshold.
CUT_FRAME_WIDTH = 128
# Frames per second actually examined. Above this, the extra frames add cost without
# adding cuts: a cut lasts one frame, but no ad cuts faster than ~8 times a second.
CUT_SAMPLE_FPS = 12.0
# Two detections closer than this collapse into one. A cross-dissolve spans several
# frames and would otherwise register as a burst of cuts.
MIN_CUT_GAP_S = 0.2

# --- OCR ---------------------------------------------------------------------------
# The hook window. Text on screen in the first two seconds is the signal; where exactly
# in those two seconds is not, at this sample size.
HOOK_WINDOW_S = 2.0
OCR_SAMPLE_INTERVAL_S = 0.5
# Below this confidence a detection is discarded. EasyOCR happily reports logos, texture
# and compression noise as low-confidence text, and `text_density` is a fraction — noise
# inflates it toward 1.0 for every creative and destroys the contrast between them.
OCR_MIN_CONFIDENCE = 0.4
# Hard ceiling on OCR calls per creative, independent of the duration cap. OCR dominates
# extraction cost; a long ad should get sparser sampling, not a longer job.
OCR_MAX_FRAMES = 60

# --- Poster frame ------------------------------------------------------------------
# Where in the ad to cut the gallery thumbnail from, when there is no detected cut to
# halve. Not t=0: the first frame of an Ad Library re-encode is very often black or a
# platform chrome card, and a gallery of black squares is a gallery of nothing.
POSTER_FALLBACK_S = 1.0
# The poster is a thumbnail in a three-column grid, never a full-bleed hero. Storing the
# source resolution would multiply the media bucket for pixels no surface renders.
POSTER_MAX_WIDTH = 640
POSTER_JPEG_QUALITY = 82

# --- Audio -------------------------------------------------------------------------
AUDIO_SAMPLE_RATE = 22050
# librosa RMS framing. These are librosa's own defaults, restated here because they are
# part of the definition of `audio_energy_variance` — a different hop length yields a
# different variance for identical audio.
AUDIO_FRAME_LENGTH = 2048
AUDIO_HOP_LENGTH = 512

# --- Transcription -----------------------------------------------------------------
# `tiny` is a deliberate accuracy/cost trade. The transcript is used as a message-level
# hint alongside the Ad Library ad copy, not as a legal record.
WHISPER_MODEL = "tiny"
WHISPER_LANGUAGE = "es"

#: Every threshold that defines what a feature *means*. Order-independent (sorted on hash).
DEFINITIONS: dict[str, Any] = {
    "cut_diff_threshold": CUT_DIFF_THRESHOLD,
    "cut_frame_width": CUT_FRAME_WIDTH,
    "cut_sample_fps": CUT_SAMPLE_FPS,
    "min_cut_gap_s": MIN_CUT_GAP_S,
    "hook_window_s": HOOK_WINDOW_S,
    "ocr_sample_interval_s": OCR_SAMPLE_INTERVAL_S,
    "ocr_min_confidence": OCR_MIN_CONFIDENCE,
    "ocr_max_frames": OCR_MAX_FRAMES,
    "poster_fallback_s": POSTER_FALLBACK_S,
    "poster_max_width": POSTER_MAX_WIDTH,
    "poster_jpeg_quality": POSTER_JPEG_QUALITY,
    "audio_sample_rate": AUDIO_SAMPLE_RATE,
    "audio_frame_length": AUDIO_FRAME_LENGTH,
    "audio_hop_length": AUDIO_HOP_LENGTH,
    "whisper_model": WHISPER_MODEL,
    "whisper_language": WHISPER_LANGUAGE,
}


def definitions_digest() -> str:
    """A stable fingerprint of the feature definitions.

    Pinned by a test. Its only job is to make an unversioned threshold change impossible
    to land by accident.
    """
    canonical = json.dumps(DEFINITIONS, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


#: Names that may legitimately appear in `skipped_features`. Kept explicit so a typo in a
#: skip reason ("audio_energy" vs "audio_energy_variance") cannot survive review — a
#: mislabelled skip reads downstream as a feature that was never attempted.
MEASURABLE_FEATURES = (
    "duration_s",
    "first_cut_time_s",
    "cuts_per_second",
    "text_in_first_2s",
    "text_density",
    "first_line_transcript",
    "full_transcript",
    "audio_energy_variance",
    "poster_storage_path",
)


@dataclass(slots=True)
class CreativeFeatures:
    """One extracted row. Every measurement is optional by design.

    A static image has no cuts. A silent video has no audio energy. OCR fails on frames a
    human reads without effort. Rule 1 of the spec is that each of those yields `None`
    plus an entry in `skipped_features` — a partial row is a result, not an error, because
    an ad we could only partially measure still carries a survival outcome.
    """

    duration_s: float | None = None
    first_cut_time_s: float | None = None
    cuts_per_second: float | None = None
    text_in_first_2s: bool | None = None
    text_density: float | None = None
    first_line_transcript: str | None = None
    full_transcript: str | None = None
    audio_energy_variance: float | None = None
    #: Storage key of the poster, filled in by the worker once the JPEG is uploaded. The
    #: pipeline cannot set it: extraction runs on a temp file and knows nothing about
    #: buckets, and a path recorded for an object that failed to upload is a broken image
    #: in the gallery with a non-null column swearing there is one.
    poster_storage_path: str | None = None

    analysis_cap_s: float | None = None
    truncated: bool = False
    skipped_features: list[str] = field(default_factory=list)
    schema_version: int = FEATURE_SCHEMA_VERSION

    #: The encoded poster, in transit between the pipeline and the upload. Excluded from
    #: `to_row()` — it is the payload the column points at, not a column.
    poster_jpeg: bytes | None = field(default=None, metadata={"row": False})

    def skip(self, *names: str) -> None:
        """Record that a feature could not be measured, without failing the extraction."""
        for name in names:
            if name not in MEASURABLE_FEATURES:
                raise ValueError(f"unknown feature name: {name!r}")
            if name not in self.skipped_features:
                self.skipped_features.append(name)

    def to_row(self) -> dict[str, Any]:
        return {
            f.name: getattr(self, f.name)
            for f in fields(self)
            if f.metadata.get("row", True)
        }
