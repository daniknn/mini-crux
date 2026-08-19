"""OpenCV frame work: probing, sampling, and cut detection.

One decode pass, bounded memory
-------------------------------
Cut detection wants many frames (12/s) at low resolution; OCR wants few frames (2/s) at
full resolution. Decoding twice is the obvious implementation and roughly doubles the
wall-clock cost of the cheapest part of the pipeline. Holding every frame from one pass is
the other obvious implementation and puts ~700 full-resolution frames in RAM per creative.

So this module streams: it decodes once, folds each frame into the running cut diff
immediately, and retains only the (capped) subset OCR will actually look at.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .features import (
    CUT_DIFF_THRESHOLD,
    CUT_FRAME_WIDTH,
    CUT_SAMPLE_FPS,
    MIN_CUT_GAP_S,
    OCR_MAX_FRAMES,
    OCR_SAMPLE_INTERVAL_S,
    POSTER_JPEG_QUALITY,
    POSTER_MAX_WIDTH,
)


class UnreadableMedia(RuntimeError):
    """The file could not be opened or yielded no decodable frames.

    Distinct from a feature that degrades to `None`: there is nothing to measure at all,
    so the job fails with a reason rather than writing a row of nulls that would read
    downstream as "we measured this and it was empty".
    """


@dataclass(frozen=True, slots=True)
class VideoProbe:
    duration_s: float
    fps: float
    frame_count: int
    width: int
    height: int


@dataclass(slots=True)
class VideoAnalysis:
    probe: VideoProbe
    #: Timestamps (seconds) at which a cut was detected.
    cut_times: list[float]
    #: (timestamp, BGR frame) pairs retained for OCR.
    ocr_frames: list[tuple[float, Any]]
    #: How much of the media was actually examined.
    analyzed_s: float
    truncated: bool


def _open(path: Path) -> cv2.VideoCapture:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise UnreadableMedia(f"cannot open media: {path}")
    return capture


def probe(path: Path) -> VideoProbe:
    """Read container metadata. Duration is corrected by decoding when metadata lies.

    Some Ad Library re-encodes report `frame_count = 0` or a nonsense fps. A duration of 0
    would make `cuts_per_second` a division by zero and, worse, would look like a plausible
    "very short ad" if it were silently clamped.
    """
    capture = _open(path)
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

        if fps > 0 and frame_count > 0:
            duration_s = frame_count / fps
        else:
            duration_s, decoded, fps = _measure_by_decoding(capture, fps)
            frame_count = frame_count or decoded

        if duration_s <= 0:
            raise UnreadableMedia(f"media has no measurable duration: {path}")

        return VideoProbe(
            duration_s=duration_s,
            fps=fps,
            frame_count=frame_count,
            width=width,
            height=height,
        )
    finally:
        capture.release()


def _measure_by_decoding(capture: cv2.VideoCapture, fps_hint: float) -> tuple[float, int, float]:
    decoded = 0
    while True:
        ok, _frame = capture.read()
        if not ok:
            break
        decoded += 1

    if decoded == 0:
        raise UnreadableMedia("media yielded no decodable frames")

    fps = fps_hint if fps_hint > 0 else 25.0
    return decoded / fps, decoded, fps


def _iter_frames(capture: cv2.VideoCapture, fps: float, cap_s: float) -> Iterator[tuple[float, Any]]:
    """Yield (timestamp, frame) at approximately CUT_SAMPLE_FPS, stopping at `cap_s`.

    Frame index arithmetic rather than `CAP_PROP_POS_MSEC` seeking: seeking is per-codec
    and lands on the nearest keyframe for some of them, which would make the cut timestamps
    quietly wrong on exactly the compressed formats the Ad Library serves.
    """
    stride = max(1, int(round(fps / CUT_SAMPLE_FPS))) if fps > 0 else 1
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            return
        timestamp = index / fps if fps > 0 else 0.0
        if timestamp > cap_s:
            return
        if index % stride == 0:
            yield timestamp, frame
        index += 1


def _to_diff_frame(frame: Any) -> Any:
    height, width = frame.shape[:2]
    if width > CUT_FRAME_WIDTH:
        scale = CUT_FRAME_WIDTH / width
        frame = cv2.resize(
            frame, (CUT_FRAME_WIDTH, max(1, int(height * scale))), interpolation=cv2.INTER_AREA
        )
    if frame.ndim == 3:
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return frame.astype(np.float32)


def analyze(path: Path, cap_s: float) -> VideoAnalysis:
    """Single-pass cut detection plus OCR frame collection."""
    media_probe = probe(path)
    effective_cap = min(cap_s, media_probe.duration_s)
    truncated = media_probe.duration_s > cap_s

    capture = _open(path)
    cut_times: list[float] = []
    ocr_frames: list[tuple[float, Any]] = []
    previous: Any | None = None
    last_cut_at = float("-inf")
    next_ocr_at = 0.0
    analyzed_s = 0.0

    try:
        for timestamp, frame in _iter_frames(capture, media_probe.fps, effective_cap):
            analyzed_s = timestamp

            current = _to_diff_frame(frame)
            if previous is not None:
                diff = float(np.mean(np.abs(current - previous)))
                if diff >= CUT_DIFF_THRESHOLD and timestamp - last_cut_at >= MIN_CUT_GAP_S:
                    cut_times.append(timestamp)
                    last_cut_at = timestamp
            previous = current

            if timestamp >= next_ocr_at and len(ocr_frames) < OCR_MAX_FRAMES:
                ocr_frames.append((timestamp, frame))
                next_ocr_at = timestamp + OCR_SAMPLE_INTERVAL_S
    finally:
        capture.release()

    if previous is None:
        raise UnreadableMedia(f"media yielded no decodable frames: {path}")

    return VideoAnalysis(
        probe=media_probe,
        cut_times=cut_times,
        ocr_frames=ocr_frames,
        analyzed_s=analyzed_s if analyzed_s > 0 else media_probe.duration_s,
        truncated=truncated,
    )


def nearest_frame(frames: list[tuple[float, Any]], target_s: float) -> tuple[float, Any]:
    """The retained frame closest to `target_s`.

    The poster is cut from the frames `analyze` already kept for OCR rather than from a
    second decode pass. Re-opening the file to seek one frame would double the decode cost
    of the cheapest stage, and — worse — `CAP_PROP_POS_MSEC` seeking lands on the nearest
    *keyframe* in several of the codecs the Ad Library serves, so the frame it returned
    would not be the timestamp we asked for anyway. The retained samples are 0.5s apart, so
    the answer is within a quarter-second of the target and is a frame we know decoded.

    Ties go to the earlier frame: `min` is stable, and a deterministic poster is what makes
    a re-extraction at the same schema version produce the same bytes.
    """
    if not frames:
        raise UnreadableMedia("no frames retained to cut a poster from")
    return min(frames, key=lambda item: abs(item[0] - target_s))


def encode_poster(frame: Any) -> bytes:
    """Downscale to `POSTER_MAX_WIDTH` and encode as JPEG."""
    height, width = frame.shape[:2]
    if width > POSTER_MAX_WIDTH:
        scale = POSTER_MAX_WIDTH / width
        frame = cv2.resize(
            frame,
            (POSTER_MAX_WIDTH, max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), POSTER_JPEG_QUALITY])
    if not ok:
        raise UnreadableMedia("could not encode poster frame as JPEG")
    return bytes(buffer.tobytes())


def read_image(path: Path) -> Any:
    """Load a still image as a BGR frame. Raises `UnreadableMedia` if it is not one."""
    frame = cv2.imread(str(path))
    if frame is None:
        raise UnreadableMedia(f"cannot read image: {path}")
    return frame
