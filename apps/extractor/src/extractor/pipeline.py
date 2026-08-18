"""Per-creative extraction: run every analyzer, degrade instead of failing.

The distinction this module exists to preserve
----------------------------------------------
There are three different nulls, and collapsing them corrupts the analysis downstream:

* **Measured absent.** A single-shot video really has no cut. `first_cut_time_s` is None,
  `cuts_per_second` is 0.0, and nothing is skipped. The creative belongs in the n.
* **Not measurable.** OCR was unavailable, so `text_density` is None *and*
  `text_density` appears in `skipped_features`. The creative must be excluded from any n
  computed over that feature — silently treating it as 0.0 would drag the cohort mean.
* **Not attempted.** No row at all, because the job has not run yet.

Only the first two are this module's business, and the rule that separates them is: a
`None` with no skip entry is a measurement; a `None` with a skip entry is an admission.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

from .backends import (
    AudioBackend,
    BackendUnavailable,
    NoAudioTrack,
    OcrBackend,
    TranscriptBackend,
    confident,
)
from .features import (
    FEATURE_SCHEMA_VERSION,
    HOOK_WINDOW_S,
    POSTER_FALLBACK_S,
    CreativeFeatures,
)
from .video import UnreadableMedia, analyze, encode_poster, nearest_frame, read_image

logger = logging.getLogger(__name__)

#: Media longer than this is sampled up to the cap rather than skipped (spec rule 6). The
#: cap is written onto the row so the analysis knows a `text_density` came from the first
#: 120s of a long ad rather than from the whole of a short one.
DEFAULT_CAP_S = 120.0


def extract(
    media_path: Path,
    *,
    media_type: str,
    ocr: OcrBackend | None = None,
    transcriber: TranscriptBackend | None = None,
    audio: AudioBackend | None = None,
    cap_s: float = DEFAULT_CAP_S,
) -> CreativeFeatures:
    """Extract every feature we can from one local media file.

    Raises `UnreadableMedia` only when there is nothing to measure at all — a corrupt file
    or an unsupported container. That is a job failure with a reason (spec acceptance
    criterion 3), deliberately not a row of nulls.
    """
    features = CreativeFeatures(analysis_cap_s=cap_s, schema_version=FEATURE_SCHEMA_VERSION)

    if media_type == "image":
        return _extract_image(media_path, features, ocr)
    return _extract_video(media_path, features, ocr, transcriber, audio, cap_s)


def _extract_video(
    media_path: Path,
    features: CreativeFeatures,
    ocr: OcrBackend | None,
    transcriber: TranscriptBackend | None,
    audio: AudioBackend | None,
    cap_s: float,
) -> CreativeFeatures:
    # Not guarded: if the video cannot be decoded there is no creative to describe, and
    # every downstream feature would be a skip. That is a failed job, not a row.
    analysis = analyze(media_path, cap_s)

    features.duration_s = round(analysis.probe.duration_s, 3)
    features.truncated = analysis.truncated
    features.first_cut_time_s = (
        round(analysis.cut_times[0], 3) if analysis.cut_times else None
    )
    # Denominator is what we actually looked at, not the full duration. On a truncated ad
    # the two differ, and dividing by the full duration would report a rate we never
    # observed over the tail we never examined.
    denominator = analysis.analyzed_s or analysis.probe.duration_s
    features.cuts_per_second = round(len(analysis.cut_times) / denominator, 4)

    _guard(
        features,
        ("text_in_first_2s", "text_density"),
        lambda: _run_ocr(features, analysis.ocr_frames, ocr),
    )
    _guard(
        features,
        ("first_line_transcript", "full_transcript"),
        lambda: _run_transcript(features, media_path, transcriber),
    )
    _guard(
        features,
        ("audio_energy_variance",),
        lambda: _run_audio(features, media_path, audio),
    )
    _guard(
        features,
        ("poster_storage_path",),
        lambda: _run_poster(features, analysis.ocr_frames, _poster_target_s(features)),
    )

    return features


def _poster_target_s(features: CreativeFeatures) -> float:
    """Where to cut the poster: half the time to the first cut, else `POSTER_FALLBACK_S`.

    Halving the first cut lands inside the opening shot, which is the shot the advertiser
    composed as the ad's face. Cutting *at* the cut would land on the transition frame, and
    cutting at t=0 lands on the black or chrome frame Ad Library re-encodes so often begin
    with — which is the whole reason this is not just `frames[0]`.

    A single-shot video has no cut to halve, so it falls back; so does a video whose only
    cut is so early that half of it is back in the black frame we were avoiding.
    """
    first_cut = features.first_cut_time_s
    if first_cut is None:
        return POSTER_FALLBACK_S
    halved = first_cut / 2
    return halved if halved >= POSTER_FALLBACK_S else POSTER_FALLBACK_S


def _extract_image(
    media_path: Path, features: CreativeFeatures, ocr: OcrBackend | None
) -> CreativeFeatures:
    """A still has one frame, no timeline and no audio.

    Every time-based feature is skipped rather than zeroed. `cuts_per_second = 0` for an
    image would be arithmetically true and analytically poisonous: it would put stills in
    the same bucket as single-shot video, and "the advertiser chose not to cut" is a very
    different fact from "this medium cannot cut".
    """
    frame = read_image(media_path)

    features.skip(
        "duration_s",
        "first_cut_time_s",
        "cuts_per_second",
        "first_line_transcript",
        "full_transcript",
        "audio_energy_variance",
    )
    _guard(
        features,
        ("text_in_first_2s", "text_density"),
        lambda: _run_ocr(features, [(0.0, frame)], ocr),
    )
    # A still is its own poster. Re-encoded rather than pointed at, so the gallery renders
    # one predictable size and format instead of whatever the advertiser uploaded.
    _guard(features, ("poster_storage_path",), lambda: _run_poster(features, [(0.0, frame)], 0.0))
    return features


def _guard(
    features: CreativeFeatures, owned: tuple[str, ...], run: Callable[[], None]
) -> None:
    """Run one analyzer; on any failure mark the features it owns as skipped.

    The exception is swallowed on purpose — spec rule 1. It is logged with the feature
    names so a systematically failing backend is visible in the worker logs rather than
    only as a column of nulls noticed weeks later.
    """
    try:
        run()
    except (BackendUnavailable, NoAudioTrack) as exc:
        logger.info("skipping %s: %s", ", ".join(owned), exc)
        features.skip(*owned)
    # Broad on purpose: any analyzer failure degrades to a skip. A model that raises must
    # not cost us the features we already measured on this creative.
    except Exception as exc:
        logger.warning("analyzer for %s failed: %s", ", ".join(owned), exc, exc_info=True)
        features.skip(*owned)


def _run_ocr(
    features: CreativeFeatures,
    frames: list[tuple[float, object]],
    ocr: OcrBackend | None,
) -> None:
    if ocr is None:
        raise BackendUnavailable("no OCR backend configured")
    if not frames:
        raise BackendUnavailable("no frames sampled for OCR")

    with_text = 0
    hook_has_text = False
    for timestamp, frame in frames:
        texts = confident(ocr.detect(frame))
        if texts:
            with_text += 1
            if timestamp < HOOK_WINDOW_S:
                hook_has_text = True

    features.text_density = round(with_text / len(frames), 4)
    features.text_in_first_2s = hook_has_text


def _run_transcript(
    features: CreativeFeatures, media_path: Path, transcriber: TranscriptBackend | None
) -> None:
    if transcriber is None:
        raise BackendUnavailable("no transcript backend configured")

    transcript = transcriber.transcribe(media_path)
    if not transcript.lines:
        # Measured absent, not unmeasurable: the model ran and heard no speech. Music-only
        # ads are common and their emptiness is a real signal, so this is not a skip.
        features.first_line_transcript = None
        features.full_transcript = ""
        return

    features.first_line_transcript = transcript.first_line
    features.full_transcript = transcript.full_text


def _run_poster(
    features: CreativeFeatures,
    frames: list[tuple[float, object]],
    target_s: float,
) -> None:
    """Encode the poster. Sets only the bytes — the worker sets the path after uploading.

    Raising here is the intended failure mode, not an escape hatch: `_guard` turns it into
    `poster_storage_path` in `skipped_features`, which is what tells the gallery to render a
    text card rather than an image element pointed at nothing.
    """
    features.poster_jpeg = encode_poster(nearest_frame(list(frames), target_s)[1])


def _run_audio(
    features: CreativeFeatures, media_path: Path, audio: AudioBackend | None
) -> None:
    if audio is None:
        raise BackendUnavailable("no audio backend configured")
    features.audio_energy_variance = audio.energy_variance(media_path)


__all__ = ["DEFAULT_CAP_S", "UnreadableMedia", "extract"]
