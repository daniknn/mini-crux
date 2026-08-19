"""Test doubles and synthetic media.

Videos are *generated*, not committed. A checked-in MP4 is opaque: when a cut-detection
test fails you cannot tell whether the code broke or the fixture always had four cuts
rather than three. Generating them from an explicit scene list means the expected answer is
written next to the input, in the test, in plain Python.

It also keeps the repo free of binary blobs whose provenance and licensing nobody can
reconstruct in a year — which matters more than usual here, given the media this product
handles in production belongs to somebody else.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .backends import TextDetection, Transcript
from .features import CreativeFeatures
from .media import LandedMedia
from .store import Creative, DuplicateMessage, Job

# ---------------------------------------------------------------------------------
# Synthetic media
# ---------------------------------------------------------------------------------


#: Scene colours, far apart in luminance so a scene change clears the cut threshold by a
#: wide margin. Exported because the poster tests identify *which* scene a frame came from,
#: and a palette copied into the test would drift from the one the generator uses.
SCENE_PALETTE = [(20, 20, 20), (230, 230, 230), (20, 200, 20), (200, 20, 200), (240, 240, 20)]


def _write(path: Path, frames: Any, fps: int, size: tuple[int, int]) -> Path:
    width, height = size
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("OpenCV could not open an mp4v writer")
    try:
        for frame in frames:
            writer.write(frame)
    finally:
        writer.release()

    if not path.exists() or path.stat().st_size == 0:
        raise RuntimeError(f"video writer produced nothing at {path}")
    return path


def make_segment_video(
    path: Path,
    segments: list[tuple[float, tuple[int, int, int]]],
    *,
    fps: int = 24,
    size: tuple[int, int] = (320, 240),
) -> Path:
    """Flat-colour segments of explicitly given (seconds, BGR).

    `make_video` divides a duration into equal scenes, which is convenient and useless for
    the poster: the frame it picks always lands in the opening scene, so an implementation
    that cut at t=0 would produce the identical colour and the test would pass. Uneven
    segments — specifically a short dark lead-in — are what make the two distinguishable.
    """
    width, height = size

    def frames() -> Any:
        for seconds, colour in segments:
            for _ in range(max(1, int(round(seconds * fps)))):
                yield np.full((height, width, 3), colour, dtype=np.uint8)

    return _write(path, frames(), fps, size)


def make_ramp_video(
    path: Path,
    *,
    ramp_s: float = 4.0,
    tail_s: float = 1.0,
    peak: int = 200,
    fps: int = 24,
    size: tuple[int, int] = (320, 240),
) -> Path:
    """A slow brightness ramp, then one hard cut into green.

    The ramp is the point. Every frame of it is a different, *identifiable* brightness, so a
    poster taken at 2.0s, at 1.0s and at 0.0s are three distinguishable images — which is
    what lets a test tell "half the first cut" apart from "the fallback" and from "the first
    frame". Against a flat opening shot all three produce the same pixels and the test
    proves nothing.

    The ramp rises slowly enough not to register as a cut: ~4 units of mean per-pixel change
    between sampled frames, against a `CUT_DIFF_THRESHOLD` of 12.
    """
    width, height = size
    ramp_frames = max(1, int(round(ramp_s * fps)))

    def frames() -> Any:
        for index in range(ramp_frames):
            value = int(peak * index / ramp_frames)
            yield np.full((height, width, 3), (value, value, value), dtype=np.uint8)
        for _ in range(max(1, int(round(tail_s * fps)))):
            yield np.full((height, width, 3), (20, 200, 20), dtype=np.uint8)

    return _write(path, frames(), fps, size)


def decode_jpeg(data: bytes) -> Any:
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("poster bytes are not a decodable JPEG")
    return frame


def mean_bgr(frame: Any) -> tuple[float, float, float]:
    b, g, r = frame.reshape(-1, 3).mean(axis=0)
    return float(b), float(g), float(r)


def make_video(
    path: Path,
    *,
    scenes: int = 3,
    seconds: float = 3.0,
    fps: int = 24,
    size: tuple[int, int] = (320, 240),
) -> Path:
    """Write an MP4 of `scenes` flat-colour segments of equal length.

    Colours are far apart in luminance on purpose, so a scene change clears the cut
    threshold by a wide margin. A test that depended on a borderline diff would fail on a
    different codec build rather than on a real regression.
    """
    width, height = size
    total_frames = max(1, int(round(seconds * fps)))
    frames_per_scene = max(1, total_frames // max(1, scenes))

    def frames() -> Any:
        for index in range(total_frames):
            scene = min(index // frames_per_scene, scenes - 1)
            colour = SCENE_PALETTE[scene % len(SCENE_PALETTE)]
            yield np.full((height, width, 3), colour, dtype=np.uint8)

    return _write(path, frames(), fps, size)


def make_image(path: Path, *, size: tuple[int, int] = (320, 240)) -> Path:
    width, height = size
    frame = np.full((height, width, 3), (120, 90, 60), dtype=np.uint8)
    if not cv2.imwrite(str(path), frame):
        raise RuntimeError(f"could not write image at {path}")
    return path


def make_corrupt(path: Path) -> Path:
    """A file with a video extension and bytes that are not a video."""
    path.write_bytes(b"not a video, just some bytes" * 8)
    return path


# ---------------------------------------------------------------------------------
# Backend doubles
# ---------------------------------------------------------------------------------


@dataclass
class FakeOcr:
    """Reports text on the frames whose index is in `frames_with_text`.

    Confidence is configurable so the versioned floor in `features.OCR_MIN_CONFIDENCE` can
    be exercised directly — a backend that always returned 0.99 would let a broken filter
    pass.
    """

    frames_with_text: set[int] = field(default_factory=set)
    confidence: float = 0.9
    text: str = "compra ahora"
    name: str = "fake-ocr"
    calls: int = 0

    def detect(self, frame: Any) -> list[TextDetection]:
        index = self.calls
        self.calls += 1
        if index in self.frames_with_text:
            return [TextDetection(text=self.text, confidence=self.confidence)]
        return []


@dataclass
class FakeTranscriber:
    lines: tuple[str, ...] = ("primera línea", "segunda línea")
    name: str = "fake-transcriber"

    def transcribe(self, media_path: Path) -> Transcript:
        return Transcript(lines=self.lines)


@dataclass
class FakeAudio:
    variance: float = 0.0125
    name: str = "fake-audio"

    def energy_variance(self, media_path: Path) -> float:
        return self.variance


class FailingBackend:
    """Raises whatever it is given. Proves a broken analyzer degrades rather than fails."""

    name = "failing"

    def __init__(self, error: Exception) -> None:
        self._error = error

    def detect(self, frame: Any) -> list[TextDetection]:
        raise self._error

    def transcribe(self, media_path: Path) -> Transcript:
        raise self._error

    def energy_variance(self, media_path: Path) -> float:
        raise self._error


# ---------------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------------


@dataclass
class StoredFeatures:
    creative_id: str
    schema_version: int
    features: CreativeFeatures
    media: LandedMedia
    trace_id: str
    is_stale: bool = False


class MemoryJobStore:
    """Mirrors the semantics the SQL statements implement, and nothing more.

    Deliberately not a database: what it exists to test is the worker's control flow —
    claim, heartbeat, retry, no-op, checkpoint. The SQL itself is validated against real
    Postgres in `packages/db/test/worker-sql.test.ts`, and the split is described in
    `store.py`.
    """

    def __init__(self) -> None:
        self.jobs: list[dict[str, Any]] = []
        self.features: dict[tuple[str, int], StoredFeatures] = {}
        self.creatives: dict[str, Creative] = {}
        self.processed: set[str] = set()
        self.audit: list[dict[str, Any]] = []
        self.heartbeats: list[str] = []

    # -- seeding -------------------------------------------------------------------

    def add_creative(self, creative: Creative) -> Creative:
        self.creatives[creative.id] = creative
        return creative

    def enqueue(
        self,
        *,
        creative_id: str,
        workspace_id: str,
        message_id: str,
        trace_id: str = "trc_test",
        schema_version: int | None = None,
        max_attempts: int = 3,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"creative_id": creative_id}
        if schema_version is not None:
            payload["schema_version"] = schema_version
        row = {
            "id": f"job_{len(self.jobs) + 1}",
            "workspace_id": workspace_id,
            "message_id": message_id,
            "type": "extract",
            "payload": payload,
            "trace_id": trace_id,
            "actor": {"type": "agent", "id": "extractor"},
            "attempts": 0,
            "max_attempts": max_attempts,
            "status": "pending",
            "last_error": None,
        }
        self.jobs.append(row)
        return row

    def job(self, job_id: str) -> dict[str, Any]:
        return next(row for row in self.jobs if row["id"] == job_id)

    def mark_stale(self, below_version: int) -> int:
        marked = 0
        for stored in self.features.values():
            if stored.schema_version < below_version and not stored.is_stale:
                stored.is_stale = True
                marked += 1
        return marked

    # -- JobStore ------------------------------------------------------------------

    async def claim(self, job_types: tuple[str, ...]) -> Job | None:
        for row in self.jobs:
            if row["status"] == "pending" and row["type"] in job_types:
                row["status"] = "running"
                row["attempts"] += 1
                return Job(
                    id=row["id"],
                    workspace_id=row["workspace_id"],
                    message_id=row["message_id"],
                    type=row["type"],
                    payload=dict(row["payload"]),
                    trace_id=row["trace_id"],
                    actor=dict(row["actor"]),
                    attempts=row["attempts"],
                    max_attempts=row["max_attempts"],
                )
        return None

    async def heartbeat(self, job_id: str) -> None:
        self.heartbeats.append(job_id)

    async def complete(self, job_id: str) -> None:
        self.job(job_id)["status"] = "succeeded"

    async def fail(
        self, job_id: str, error: str, backoff_s: float, *, permanent: bool = False
    ) -> None:
        row = self.job(job_id)
        row["last_error"] = error
        exhausted = permanent or row["attempts"] >= row["max_attempts"]
        row["status"] = "failed" if exhausted else "pending"

    async def load_creative(self, creative_id: str) -> Creative | None:
        return self.creatives.get(creative_id)

    async def already_extracted(self, creative_id: str, schema_version: int) -> bool:
        stored = self.features.get((creative_id, schema_version))
        return stored is not None and not stored.is_stale

    async def save_features(
        self,
        *,
        job: Job,
        creative: Creative,
        features: CreativeFeatures,
        media: LandedMedia,
        extractor_version: str,
    ) -> None:
        if job.message_id in self.processed:
            raise DuplicateMessage(job.message_id)
        self.processed.add(job.message_id)
        self.features[(creative.id, features.schema_version)] = StoredFeatures(
            creative_id=creative.id,
            schema_version=features.schema_version,
            features=features,
            media=media,
            trace_id=job.trace_id,
        )
        self.audit.append(
            {
                "type": "creative.features_extracted",
                "trace_id": job.trace_id,
                "creative_id": creative.id,
                "skipped_features": list(features.skipped_features),
            }
        )


class SlowMediaStore:
    """Wraps a store and blocks on `get`, simulating a long extraction.

    Used to prove the heartbeat keeps ticking while blocking work is in flight. The sleep
    is `time.sleep`, not `asyncio.sleep`, precisely because the point is to occupy a thread
    the way OpenCV does.
    """

    def __init__(self, inner: Any, delay_s: float) -> None:
        self._inner = inner
        self._delay_s = delay_s

    def exists(self, path: str) -> bool:
        return self._inner.exists(path)

    def put(self, path: str, data: bytes, *, content_type: str) -> None:
        self._inner.put(path, data, content_type=content_type)

    def get(self, path: str) -> bytes:
        import time

        time.sleep(self._delay_s)
        return self._inner.get(path)


class FlakyMediaStore:
    """Fails `failures` times, then behaves. Stands in for a transient CDN or storage blip.

    Distinct from `SlowMediaStore` and from a corrupt file: this is the case that *should*
    be retried, and the worker has to tell it apart from the case that should not.
    """

    def __init__(self, inner: Any, failures: int) -> None:
        self._inner = inner
        self._remaining = failures
        self.attempts = 0

    def exists(self, path: str) -> bool:
        return self._inner.exists(path)

    def put(self, path: str, data: bytes, *, content_type: str) -> None:
        self._inner.put(path, data, content_type=content_type)

    def get(self, path: str) -> bytes:
        self.attempts += 1
        if self._remaining > 0:
            self._remaining -= 1
            raise RuntimeError("storage temporarily unavailable")
        return self._inner.get(path)


class PosterHostileMediaStore:
    """Accepts every write except the poster's.

    The poster upload is the one storage call the worker is allowed to lose, so it needs a
    store that fails *only* that call. `FlakyMediaStore` fails the download and turns the
    job into a retry, which never reaches the poster; a store that failed every `put` would
    never land the media either, and the job would fail long before there was a poster to
    lose. Narrowing the failure to the poster key is what leaves everything else about the
    creative measured and lets the test assert that the row is complete apart from one
    column.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.refused = 0

    def exists(self, path: str) -> bool:
        return self._inner.exists(path)

    def put(self, path: str, data: bytes, *, content_type: str) -> None:
        if ".poster." in path:
            self.refused += 1
            raise RuntimeError("storage unavailable")
        self._inner.put(path, data, content_type=content_type)

    def get(self, path: str) -> bytes:
        return self._inner.get(path)


class SemanticFrameHostileMediaStore:
    """Accepts every write except the semantic frames'. Poster's mirror image.

    Same narrowing reasoning as `PosterHostileMediaStore`, aimed at the other JPEGs the
    worker uploads: failing only `.semantic.` keys proves the poster and every measured
    feature survive a storage outage confined to frame sampling, and that the failure costs
    the whole array rather than a partial one (`_store_semantic_frames` is all-or-nothing).
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.refused = 0

    def exists(self, path: str) -> bool:
        return self._inner.exists(path)

    def put(self, path: str, data: bytes, *, content_type: str) -> None:
        if ".semantic." in path:
            self.refused += 1
            raise RuntimeError("storage unavailable")
        self._inner.put(path, data, content_type=content_type)

    def get(self, path: str) -> bytes:
        return self._inner.get(path)


async def drain(worker: Any, limit: int = 50) -> int:
    """Run jobs until the queue reports empty. Returns how many were processed."""
    processed = 0
    for _ in range(limit):
        if not await worker.run_once():
            return processed
        processed += 1
        await asyncio.sleep(0)
    raise RuntimeError("queue did not drain")
