"""Swappable backends for the three expensive analyzers.

Why protocols instead of importing EasyOCR and whisper directly
---------------------------------------------------------------
Two reasons, and only one of them is about CI speed.

The load-bearing one: OCR and transcription are *models*, and a model is a dependency
whose output changes when it is upgraded. Behind a protocol, the orchestration — sampling
cadence, confidence floor, degradation rules, what counts as a skip — is testable against
a deterministic fake, so a failing test means the pipeline is wrong rather than that
EasyOCR shifted a bounding box by a pixel. Model-quality regressions are a separate
concern from pipeline correctness and should not be able to masquerade as each other.

The practical one: `easyocr` and `faster-whisper` pull torch, roughly 2GB of wheels. They
live in the `ml` extra and are imported lazily inside the concrete backends, so CI installs
neither. The cost is honest and stated in the spec: CI proves the pipeline, not the models.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .features import (
    AUDIO_FRAME_LENGTH,
    AUDIO_HOP_LENGTH,
    AUDIO_SAMPLE_RATE,
    OCR_MIN_CONFIDENCE,
    WHISPER_LANGUAGE,
    WHISPER_MODEL,
)


class BackendUnavailable(RuntimeError):
    """The optional dependency backing this analyzer is not installed.

    Raised at *use* time rather than import time so a worker without the `ml` extra still
    starts, still extracts cuts and duration, and records the rest as skipped. Failing the
    whole job because one model is missing would throw away the features we can measure.
    """


@dataclass(frozen=True, slots=True)
class TextDetection:
    text: str
    confidence: float


@dataclass(frozen=True, slots=True)
class Transcript:
    """`lines` is ordered; the first is the hook line the spec asks for."""

    lines: tuple[str, ...]

    @property
    def first_line(self) -> str | None:
        return self.lines[0] if self.lines else None

    @property
    def full_text(self) -> str | None:
        return " ".join(self.lines) if self.lines else None


@runtime_checkable
class OcrBackend(Protocol):
    name: str

    def detect(self, frame: Any) -> list[TextDetection]:
        """Return every text detection in one BGR frame, unfiltered by confidence.

        Filtering is the pipeline's job, not the backend's: the confidence floor is a
        feature *definition* (see `features.OCR_MIN_CONFIDENCE`) and must be versioned
        with the others, not buried in whichever model happens to be installed.
        """
        ...


@runtime_checkable
class TranscriptBackend(Protocol):
    name: str

    def transcribe(self, media_path: Path) -> Transcript: ...


@runtime_checkable
class AudioBackend(Protocol):
    name: str

    def energy_variance(self, media_path: Path) -> float:
        """Variance of the RMS energy envelope. Raises if the media carries no audio."""
        ...


class NoAudioTrack(RuntimeError):
    """The media has no audio stream — a common, expected case, not a failure."""


# ---------------------------------------------------------------------------------
# Default implementations. Each imports its heavy dependency inside the method, so
# constructing the worker never costs a model load and a missing extra degrades to a
# skipped feature instead of an ImportError at startup.
# ---------------------------------------------------------------------------------


class EasyOcrBackend:
    name = "easyocr"

    def __init__(self, languages: tuple[str, ...] = ("es", "en")) -> None:
        self._languages = list(languages)
        self._reader: Any | None = None

    def _get_reader(self) -> Any:
        if self._reader is None:
            try:
                import easyocr
            except ImportError as exc:  # pragma: no cover - requires the `ml` extra
                raise BackendUnavailable("easyocr is not installed (extra: ml)") from exc
            # GPU off: Fly.io machines are CPU-only, and easyocr's default of gpu=True
            # emits a warning and silently falls back, which `filterwarnings = error`
            # would turn into a crash mid-batch.
            self._reader = easyocr.Reader(self._languages, gpu=False, verbose=False)
        return self._reader

    def detect(self, frame: Any) -> list[TextDetection]:
        reader = self._get_reader()
        results = reader.readtext(frame)
        return [
            TextDetection(text=str(text), confidence=float(confidence))
            for _box, text, confidence in results
        ]


class FasterWhisperBackend:
    name = "faster-whisper"

    def __init__(self, model_size: str = WHISPER_MODEL, language: str = WHISPER_LANGUAGE) -> None:
        self._model_size = model_size
        self._language = language
        self._model: Any | None = None

    def _get_model(self) -> Any:
        if self._model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover - requires the `ml` extra
                raise BackendUnavailable("faster-whisper is not installed (extra: ml)") from exc
            self._model = WhisperModel(self._model_size, device="cpu", compute_type="int8")
        return self._model

    def transcribe(self, media_path: Path) -> Transcript:
        model = self._get_model()
        # `language` is pinned rather than detected: the market is Mexico and the clips are
        # short. Auto-detection on two seconds of music confidently returns Welsh.
        segments, _info = model.transcribe(str(media_path), language=self._language)
        lines = tuple(text for segment in segments if (text := segment.text.strip()))
        return Transcript(lines=lines)


class LibrosaAudioBackend:
    name = "librosa"

    def energy_variance(self, media_path: Path) -> float:
        try:
            import librosa
            import numpy as np
        except ImportError as exc:  # pragma: no cover - requires the `ml` extra
            raise BackendUnavailable("librosa is not installed (extra: ml)") from exc

        waveform, _sr = librosa.load(str(media_path), sr=AUDIO_SAMPLE_RATE, mono=True)
        if waveform.size == 0 or not np.any(waveform):
            # A track of pure silence is not the same as a missing track, but for this
            # feature both mean the same thing: there is no energy envelope to measure.
            raise NoAudioTrack(f"{media_path} carries no audible audio")

        rms = librosa.feature.rms(
            y=waveform, frame_length=AUDIO_FRAME_LENGTH, hop_length=AUDIO_HOP_LENGTH
        )[0]
        return float(np.var(rms))


def confident(detections: list[TextDetection], floor: float = OCR_MIN_CONFIDENCE) -> list[str]:
    """Apply the versioned confidence floor. Lives here so every caller applies it."""
    return [d.text.strip() for d in detections if d.confidence >= floor and d.text.strip()]
