"""Environment configuration. Reads, validates, and fails fast.

DashOne §3: secrets live in Doppler, code reads env and fails fast if missing. "Fails fast"
means at startup, not at first use — a worker that boots, claims a job, and only then
discovers it has no database credential has already taken that job out of the queue.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .features import WHISPER_MODEL
from .media import DEFAULT_MEDIA_BUCKET
from .pipeline import DEFAULT_CAP_S


class MissingConfig(RuntimeError):
    pass


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise MissingConfig(
            f"{name} is not set. Secrets live in Doppler: run `doppler run -- <command>`."
        )
    return value


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise MissingConfig(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    supabase_url: str
    service_role_key: str
    media_bucket: str
    poll_interval_s: float
    cap_s: float
    whisper_model: str

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            database_url=_require("SUPABASE_DB_URL"),
            supabase_url=_require("SUPABASE_URL"),
            service_role_key=_require("SUPABASE_SERVICE_ROLE_KEY"),
            media_bucket=os.environ.get("SUPABASE_MEDIA_BUCKET", DEFAULT_MEDIA_BUCKET),
            # The env var is in milliseconds to match the TypeScript side, which reads the
            # same Doppler key. Diverging units across two readers of one value is a bug
            # waiting for whoever changes it next.
            poll_interval_s=_float("JOB_POLL_INTERVAL_MS", 2000.0) / 1000.0,
            cap_s=_float("EXTRACTOR_MAX_VIDEO_SECONDS", DEFAULT_CAP_S),
            whisper_model=os.environ.get("WHISPER_MODEL", WHISPER_MODEL),
        )
