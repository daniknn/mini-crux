"""The extract worker: claim a job, measure one creative, record the result.

Why the blocking work is pushed into a real thread pool
------------------------------------------------------
OpenCV, EasyOCR, faster-whisper and librosa are synchronous and CPU-heavy. Calling them
directly inside `async def` does not just slow the loop down — it stops it. No other
coroutine is scheduled for the whole of the extraction, which specifically means the
heartbeat task never runs, which means the reaper (`app.reap_stalled_jobs`) sees a job that
has gone quiet and returns it to the queue. The creative is then extracted twice while the
first extraction is still running perfectly well.

The failure presents as a spurious timeout on a healthy job, which is a very confusing
thing to debug from the outside. Hence spec rule 5, and hence
`test_worker.py::test_heartbeats_continue_during_blocking_extraction`, which fails if the
executor is ever removed.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .backends import AudioBackend, OcrBackend, TranscriptBackend
from .features import FEATURE_SCHEMA_VERSION, CreativeFeatures
from .media import LandedMedia, MediaFetchError, MediaStore, land, land_poster, poster_path
from .pipeline import DEFAULT_CAP_S, extract
from .store import Creative, DuplicateMessage, Job, JobStore
from .video import UnreadableMedia

logger = logging.getLogger(__name__)

JOB_TYPES = ("extract",)

#: Comfortably inside the reaper's 5-minute stall window, so a single missed tick — a GC
#: pause, a slow query — does not cost a job its claim.
DEFAULT_HEARTBEAT_INTERVAL_S = 15.0

#: Retry backoff. Long, because the two realistic causes are a rate-limited CDN and a
#: transiently overloaded machine, and neither is helped by trying again immediately.
BACKOFF_BASE_S = 30.0

#: Stamped on every features row as provenance. Distinct from `FEATURE_SCHEMA_VERSION`: that
#: one pins what the numbers *mean* and forces a re-extraction when it changes, this one
#: records which build produced them. They move independently — a bug fix in the sampler
#: changes this and not the definitions — so leaving it stale makes a row untraceable to the
#: code that wrote it, which is the one question worth asking when a measurement looks wrong.
EXTRACTOR_VERSION = "uc4.1"


class PermanentJobError(RuntimeError):
    """The job can never succeed: no creative, no media URL, unreadable media.

    Retrying is pointless, so `attempts` is driven straight to exhaustion rather than
    burning three cycles of the queue on a file that will not decode.
    """


class ExtractWorker:
    def __init__(
        self,
        *,
        store: JobStore,
        media_store: MediaStore,
        ocr: OcrBackend | None = None,
        transcriber: TranscriptBackend | None = None,
        audio: AudioBackend | None = None,
        executor: ThreadPoolExecutor | None = None,
        cap_s: float = DEFAULT_CAP_S,
        heartbeat_interval_s: float = DEFAULT_HEARTBEAT_INTERVAL_S,
        extractor_version: str = EXTRACTOR_VERSION,
    ) -> None:
        self._store = store
        self._media_store = media_store
        self._ocr = ocr
        self._transcriber = transcriber
        self._audio = audio
        # One worker thread by default. Concurrency comes from running more machines, not
        # more threads: extraction is CPU-bound, and a second thread on a shared-CPU Fly
        # instance halves the speed of both jobs while doubling the memory.
        self._executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix="extract")
        self._owns_executor = executor is None
        self._cap_s = cap_s
        self._heartbeat_interval_s = heartbeat_interval_s
        self._extractor_version = extractor_version

    async def run_once(self) -> bool:
        """Claim and process at most one job. False means the queue was empty."""
        job = await self._store.claim(JOB_TYPES)
        if job is None:
            return False

        try:
            await self._handle(job)
        except PermanentJobError as exc:
            logger.warning("job %s cannot succeed: %s", job.id, exc)
            # No retry at all. Spending the remaining attempts on a creative that will
            # never decode puts it back at the head of a queue ordered by `run_after`,
            # ahead of creatives that would extract fine.
            await self._store.fail(job.id, str(exc), backoff_s=0.0, permanent=True)
        except Exception as exc:
            logger.exception("job %s failed", job.id)
            await self._store.fail(job.id, str(exc), backoff_s=BACKOFF_BASE_S * job.attempts)
        return True

    async def run_forever(self, *, poll_interval_s: float = 2.0) -> None:  # pragma: no cover
        try:
            while True:
                worked = await self.run_once()
                if not worked:
                    await asyncio.sleep(poll_interval_s)
        finally:
            self.close()

    def close(self) -> None:
        if self._owns_executor:
            self._executor.shutdown(wait=True)

    # -- one job -------------------------------------------------------------------

    async def _handle(self, job: Job) -> None:
        creative_id = job.payload.get("creative_id")
        if not creative_id:
            raise PermanentJobError("job payload has no creative_id")
        schema_version = int(job.payload.get("schema_version", FEATURE_SCHEMA_VERSION))

        creative = await self._store.load_creative(str(creative_id))
        if creative is None:
            raise PermanentJobError(f"creative {creative_id} no longer exists")

        # Spec rule 3. Checked before any download, so a redelivered job for an
        # already-measured creative costs one query rather than a full extraction.
        if await self._store.already_extracted(creative.id, schema_version):
            logger.info("creative %s already at v%s; no-op", creative.id, schema_version)
            await self._store.complete(job.id)
            return

        if not creative.media_url:
            raise PermanentJobError(f"creative {creative.id} has no media_url")

        features, media = await self._run_blocking(job, creative, schema_version)

        try:
            await self._store.save_features(
                job=job,
                creative=creative,
                features=features,
                media=media,
                extractor_version=self._extractor_version,
            )
        except DuplicateMessage:
            # Another delivery of this message already committed. Its row is as good as
            # ours; the job is done, not failed.
            logger.info("message %s already processed; treating as complete", job.message_id)

        await self._store.complete(job.id)

    async def _run_blocking(
        self, job: Job, creative: Creative, schema_version: int
    ) -> tuple[CreativeFeatures, LandedMedia]:
        """Run download + extraction off the event loop, heartbeating throughout."""
        loop = asyncio.get_running_loop()
        heartbeat = asyncio.create_task(self._heartbeat_loop(job.id, creative.id))
        try:
            return await loop.run_in_executor(
                self._executor, self._land_and_extract, creative, schema_version
            )
        finally:
            heartbeat.cancel()
            # Awaited so the task is retired before the next job claims the loop; an
            # un-awaited cancelled task surfaces later as a "task was destroyed" warning,
            # and `filterwarnings = error` would turn that into a failure in an unrelated
            # test.
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass

    async def _heartbeat_loop(self, job_id: str, creative_id: str) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_interval_s)
            try:
                await self._store.heartbeat(job_id)
            except Exception:
                # A failed heartbeat is not a failed job. Worst case the reaper requeues
                # us, which is recoverable; crashing the extraction is not.
                logger.warning("heartbeat failed while extracting %s", creative_id, exc_info=True)

    def _land_and_extract(
        self, creative: Creative, schema_version: int
    ) -> tuple[CreativeFeatures, LandedMedia]:
        """Blocking. Runs in the executor thread — never call this from the loop."""
        assert creative.media_url is not None

        try:
            media, data = land(
                self._media_store,
                workspace_id=creative.workspace_id,
                creative_hash=creative.creative_hash,
                media_url=creative.media_url,
                media_type=creative.media_type,
            )
        except MediaFetchError as exc:
            raise PermanentJobError(str(exc)) from exc

        # OpenCV, whisper and librosa all take a filesystem path. The bytes are already in
        # object storage, so this copy is scratch and is deleted on the way out.
        suffix = Path(media.path).suffix or ".bin"
        with tempfile.NamedTemporaryFile(suffix=suffix) as handle:
            handle.write(data)
            handle.flush()
            try:
                features = extract(
                    Path(handle.name),
                    media_type=creative.media_type,
                    ocr=self._ocr,
                    transcriber=self._transcriber,
                    audio=self._audio,
                    cap_s=self._cap_s,
                )
            except UnreadableMedia as exc:
                raise PermanentJobError(str(exc)) from exc

        features.schema_version = schema_version
        self._store_poster(features, media)
        return features, media

    def _store_poster(self, features: CreativeFeatures, media: LandedMedia) -> None:
        """Upload the encoded poster and record its path. Never fails the job.

        The order matters: the path is set *after* the upload returns, so a storage outage
        leaves `poster_storage_path` null with `poster_storage_path` in `skipped_features`
        — a creative the gallery renders as a text card. Setting the path first and
        uploading after would leave a non-null column pointing at an object that does not
        exist, which is a broken image the schema insists is fine.

        A missing poster is a missing poster, not a missing feature row (spec: best-effort,
        never fails the job). Everything else about this creative was measured correctly and
        belongs in the panel.
        """
        if features.poster_jpeg is None:
            return

        try:
            features.poster_storage_path = land_poster(
                self._media_store,
                poster_path(media.path, features.schema_version),
                features.poster_jpeg,
            )
        except Exception:
            logger.warning("could not store poster for %s", media.path, exc_info=True)
            features.skip("poster_storage_path")
