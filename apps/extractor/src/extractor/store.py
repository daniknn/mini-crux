"""The worker's view of the database.

`JobStore` is a protocol with two implementations: asyncpg against Supabase, and an
in-memory one used by the tests. The protocol exists so the worker's *orchestration* —
claiming, heartbeating, retrying, checkpointing — is testable without a database, while the
SQL those operations issue is validated separately against a real schema (see
`statements/README.md`).

The division is deliberate. Neither half is trusted on its own: the in-memory store proves
the control flow, `worker-sql.test.ts` proves the statements, and what remains unproven is
only the asyncpg glue between them. That residue is stated in specs/UC-2 rather than
papered over.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .contracts import Actor
from .features import CreativeFeatures
from .media import LandedMedia
from .sql import statement


@dataclass(frozen=True, slots=True)
class Job:
    id: str
    workspace_id: str
    message_id: str
    type: str
    payload: dict[str, Any]
    trace_id: str
    actor: dict[str, Any]
    attempts: int
    max_attempts: int


@dataclass(frozen=True, slots=True)
class Creative:
    id: str
    workspace_id: str
    creative_hash: str
    media_type: str
    media_url: str | None


class DuplicateMessage(RuntimeError):
    """This `message_id` was already processed. The redelivery is a no-op, not an error."""


@runtime_checkable
class JobStore(Protocol):
    async def claim(self, job_types: tuple[str, ...]) -> Job | None: ...

    async def heartbeat(self, job_id: str) -> None: ...

    async def complete(self, job_id: str) -> None: ...

    async def fail(
        self, job_id: str, error: str, backoff_s: float, *, permanent: bool = False
    ) -> None: ...

    async def load_creative(self, creative_id: str) -> Creative | None: ...

    async def already_extracted(self, creative_id: str, schema_version: int) -> bool: ...

    async def save_features(
        self,
        *,
        job: Job,
        creative: Creative,
        features: CreativeFeatures,
        media: LandedMedia,
        extractor_version: str,
    ) -> None:
        """Write the features row, the idempotency ledger entry and the audit event.

        All three in one transaction, or none of them. A features row without its ledger
        entry would be re-extracted on redelivery; a ledger entry without its row would
        mark a creative done that has no measurements.
        """
        ...


class PostgresJobStore:
    """asyncpg implementation. Every statement comes from `statements/`."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def claim(self, job_types: tuple[str, ...]) -> Job | None:
        # `pool.acquire()` is a SYNC call returning an async context manager. Getting this
        # backwards is the single most common asyncpg mocking error (DashOne §1).
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(statement("claim_job"), list(job_types))
        return _to_job(row) if row else None

    async def heartbeat(self, job_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(statement("heartbeat"), job_id)

    async def complete(self, job_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(statement("complete_job"), job_id)

    async def fail(
        self, job_id: str, error: str, backoff_s: float, *, permanent: bool = False
    ) -> None:
        async with self._pool.acquire() as conn:
            if permanent:
                await conn.execute(statement("fail_job_permanent"), job_id, error)
            else:
                await conn.execute(statement("fail_job"), job_id, error, float(backoff_s))

    async def load_creative(self, creative_id: str) -> Creative | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(statement("load_creative"), creative_id)
        if row is None:
            return None
        return Creative(
            id=str(row["id"]),
            workspace_id=str(row["workspace_id"]),
            creative_hash=row["creative_hash"],
            media_type=row["media_type"],
            media_url=row["media_url"],
        )

    async def already_extracted(self, creative_id: str, schema_version: int) -> bool:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(statement("already_extracted"), creative_id, schema_version)
        return bool(row and row["extracted"])

    async def save_features(
        self,
        *,
        job: Job,
        creative: Creative,
        features: CreativeFeatures,
        media: LandedMedia,
        extractor_version: str,
    ) -> None:
        import asyncpg
        import json

        async with self._pool.acquire() as conn:
            # `conn.transaction()` is also sync-returning-an-async-CM.
            async with conn.transaction():
                try:
                    await conn.execute(
                        statement("record_message"),
                        job.message_id,
                        job.workspace_id,
                        job.id,
                        job.trace_id,
                    )
                except asyncpg.UniqueViolationError as exc:
                    raise DuplicateMessage(job.message_id) from exc

                await conn.execute(
                    statement("insert_features"),
                    creative.workspace_id,
                    creative.id,
                    features.schema_version,
                    media.path,
                    media.sha256,
                    media.size_bytes,
                    features.duration_s,
                    features.first_cut_time_s,
                    features.cuts_per_second,
                    features.text_in_first_2s,
                    features.text_density,
                    features.first_line_transcript,
                    features.full_transcript,
                    features.audio_energy_variance,
                    features.analysis_cap_s,
                    features.truncated,
                    features.skipped_features,
                    features.poster_storage_path,
                    features.semantic_frame_paths,
                    extractor_version,
                    job.trace_id,
                )

                await conn.execute(
                    statement("append_audit"),
                    creative.workspace_id,
                    job.trace_id,
                    json.dumps(job.actor),
                    "creative.features_extracted",
                    "creative",
                    creative.id,
                    json.dumps(
                        {
                            "schema_version": features.schema_version,
                            "skipped_features": features.skipped_features,
                            "truncated": features.truncated,
                            "media_sha256": media.sha256,
                        }
                    ),
                )


def _to_job(row: Any) -> Job:
    import json

    payload = row["payload"]
    actor = row["actor"]
    return Job(
        id=str(row["id"]),
        workspace_id=str(row["workspace_id"]),
        message_id=row["message_id"],
        type=row["type"],
        # asyncpg hands back jsonb as text unless a codec is registered; tolerate both so
        # the worker does not depend on connection-setup order to read its own payload.
        payload=json.loads(payload) if isinstance(payload, str) else dict(payload),
        trace_id=row["trace_id"],
        actor=json.loads(actor) if isinstance(actor, str) else dict(actor),
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
    )


def extractor_actor() -> Actor:
    return Actor(type="agent", id="extractor", label="feature-extraction")
