"""Worker entrypoint and operator CLI.

    doppler run -- python -m extractor.run --serve
    doppler run -- python -m extractor.run --creative <creative-id>
    doppler run -- python -m extractor.run --reconcile
    doppler run -- python -m extractor.run --bump-version 2

`--creative` enqueues a job and drains it rather than extracting inline. Two paths to the
same outcome would eventually disagree, and the one that runs in production is the job
path — so the operator command exercises it too, which is what makes it useful for
debugging a creative that misbehaves on the machine.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .backends import EasyOcrBackend, FasterWhisperBackend, LibrosaAudioBackend
from .config import MissingConfig, Settings
from .contracts import new_message_id, new_trace_id
from .features import FEATURE_SCHEMA_VERSION
from .media import SupabaseMediaStore
from .store import PostgresJobStore
from .worker import ExtractWorker

logger = logging.getLogger("extractor")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="extractor", description="Mini Crux feature extraction")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--serve", action="store_true", help="poll the jobs table forever")
    mode.add_argument("--creative", metavar="ID", help="extract one creative now")
    mode.add_argument(
        "--reconcile",
        action="store_true",
        help="enqueue extract jobs for creatives with no current features row",
    )
    mode.add_argument(
        "--bump-version",
        type=int,
        metavar="N",
        help="mark rows below version N stale and enqueue re-extraction",
    )
    parser.add_argument(
        "--schema-version",
        type=int,
        default=FEATURE_SCHEMA_VERSION,
        help=f"feature schema version to target (default: {FEATURE_SCHEMA_VERSION})",
    )
    return parser


async def _connect(settings: Settings):  # type: ignore[no-untyped-def]
    import asyncpg

    return await asyncpg.create_pool(settings.database_url, min_size=1, max_size=4)


def _build_worker(pool: object, settings: Settings) -> ExtractWorker:
    return ExtractWorker(
        store=PostgresJobStore(pool),
        media_store=SupabaseMediaStore(
            settings.supabase_url, settings.service_role_key, settings.media_bucket
        ),
        # Constructed unconditionally: each backend imports its heavy dependency lazily, so
        # a worker deployed without the `ml` extra still starts and degrades per feature
        # rather than failing at import.
        ocr=EasyOcrBackend(),
        transcriber=FasterWhisperBackend(model_size=settings.whisper_model),
        audio=LibrosaAudioBackend(),
        cap_s=settings.cap_s,
    )


async def _serve(settings: Settings) -> int:
    pool = await _connect(settings)
    worker = _build_worker(pool, settings)
    try:
        await worker.run_forever(poll_interval_s=settings.poll_interval_s)
    finally:
        worker.close()
        await pool.close()
    return 0


async def _extract_one(settings: Settings, creative_id: str, schema_version: int) -> int:
    pool = await _connect(settings)
    worker = _build_worker(pool, settings)
    try:
        async with pool.acquire() as conn:
            creative = await conn.fetchrow(
                "select id, workspace_id from public.creatives where id = $1::uuid", creative_id
            )
            if creative is None:
                print(f"no creative {creative_id}", file=sys.stderr)
                return 1

            await conn.execute(
                """insert into public.jobs
                     (workspace_id, message_id, type, payload, trace_id, actor)
                   values ($1, $2, 'extract', jsonb_build_object(
                     'creative_id', $3::uuid, 'schema_version', $4::integer
                   ), $5, jsonb_build_object(
                     'type', 'operator', 'id', 'cli', 'label', 'extract-one'
                   ))""",
                creative["workspace_id"],
                new_message_id(),
                creative_id,
                schema_version,
                new_trace_id(),
            )

        worked = await worker.run_once()
        print("extracted" if worked else "nothing to do")
        return 0
    finally:
        worker.close()
        await pool.close()


async def _reconcile(settings: Settings, schema_version: int) -> int:
    pool = await _connect(settings)
    try:
        async with pool.acquire() as conn:
            enqueued = await conn.fetchval(
                "select app.enqueue_pending_extractions($1::integer)", schema_version
            )
        print(f"enqueued {enqueued} extract job(s) for schema_version {schema_version}")
        return 0
    finally:
        await pool.close()


async def _bump(settings: Settings, target_version: int) -> int:
    pool = await _connect(settings)
    try:
        async with pool.acquire() as conn:
            # Two statements, not one: staleness is a fact about rows that must be recorded
            # even if the re-extraction never runs. A worker outage between them leaves
            # superseded rows correctly flagged rather than presenting as current.
            marked = await conn.fetchval(
                "select app.mark_features_stale($1::integer)", target_version
            )
            enqueued = await conn.fetchval(
                "select app.enqueue_pending_extractions($1::integer)", target_version
            )
        print(f"marked {marked} row(s) stale; enqueued {enqueued} re-extraction(s)")
        return 0
    finally:
        await pool.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = _parser().parse_args(argv)

    try:
        settings = Settings.from_env()
    except MissingConfig as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if args.serve:
        return asyncio.run(_serve(settings))
    if args.creative:
        return asyncio.run(_extract_one(settings, args.creative, args.schema_version))
    if args.reconcile:
        return asyncio.run(_reconcile(settings, args.schema_version))
    return asyncio.run(_bump(settings, args.bump_version))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
