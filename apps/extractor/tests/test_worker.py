"""Worker orchestration: claiming, no-ops, retries, checkpointing, liveness.

The database here is `MemoryJobStore`, which implements the same semantics as the SQL
statements and none of their syntax. The statements themselves are prepared against a real
migrated Postgres in `packages/db/test/worker-sql.test.ts`; see `store.py` for why the two
halves are tested separately and what is left unproven between them.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from extractor import media as media_module
from extractor.features import FEATURE_SCHEMA_VERSION
from extractor.media import MemoryMediaStore, media_path
from extractor.store import Creative
from extractor.testing import (
    FakeAudio,
    FakeOcr,
    FakeTranscriber,
    FlakyMediaStore,
    MemoryJobStore,
    SlowMediaStore,
    drain,
    make_corrupt,
    make_video,
)
from extractor.worker import DEFAULT_HEARTBEAT_INTERVAL_S, ExtractWorker

WORKSPACE = "11111111-1111-1111-1111-111111111111"
MIGRATION_0004 = (
    Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0004_features.sql"
)


def seed_creative(
    store: MemoryJobStore,
    media_store: MemoryMediaStore,
    *,
    creative_id: str,
    body: bytes,
    media_type: str = "video",
    url: str = "https://cdn.example.test/signed/ad.mp4?token=abc",
) -> Creative:
    """Register a creative and pre-land its bytes.

    Pre-landing is not a shortcut around the download: it is the state the system is
    actually in on any re-extraction, because Ad Library URLs expire. A test that fetched
    would be testing a path that only ever runs once per creative.
    """
    creative = store.add_creative(
        Creative(
            id=creative_id,
            workspace_id=WORKSPACE,
            creative_hash=f"tuple:{creative_id}",
            media_type=media_type,
            media_url=url,
        )
    )
    path = media_path(WORKSPACE, creative.creative_hash, url, media_type)
    media_store.put(path, body, content_type="video/mp4")
    return creative


@pytest.fixture
def video_bytes(tmp_path: Path) -> bytes:
    return make_video(tmp_path / "ad.mp4", scenes=3, seconds=3.0, fps=24).read_bytes()


def build_worker(
    store: MemoryJobStore, media_store: object, **overrides: object
) -> ExtractWorker:
    kwargs: dict[str, object] = {
        "store": store,
        "media_store": media_store,
        "ocr": FakeOcr(frames_with_text={0, 1}),
        "transcriber": FakeTranscriber(),
        "audio": FakeAudio(),
        "heartbeat_interval_s": 0.01,
    }
    kwargs.update(overrides)
    return ExtractWorker(**kwargs)  # type: ignore[arg-type]


class TestHappyPath:
    async def test_one_job_produces_one_features_row(self, video_bytes: bytes) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        job = store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)

        assert await worker.run_once() is True
        worker.close()

        assert store.job(job["id"])["status"] == "succeeded"
        stored = store.features[("cr_1", FEATURE_SCHEMA_VERSION)]
        assert stored.features.duration_s == pytest.approx(3.0, abs=0.05)
        assert stored.features.skipped_features == []
        assert stored.media.sha256 and stored.media.size_bytes == len(video_bytes)

    async def test_the_trace_id_survives_from_job_to_row_and_audit(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1", trace_id="trc_abc"
        )
        worker = build_worker(store, media_store)

        await worker.run_once()
        worker.close()

        assert store.features[("cr_1", FEATURE_SCHEMA_VERSION)].trace_id == "trc_abc"
        assert store.audit[0]["trace_id"] == "trc_abc"
        assert store.audit[0]["type"] == "creative.features_extracted"


class TestIdempotency:
    async def test_a_creative_already_at_the_current_version_is_a_no_op(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2")
        assert await worker.run_once() is True
        worker.close()

        # Spec rule 3: extraction happens once per creative per version. The second job
        # completes without doing the work, and does not write a second ledger entry.
        assert store.processed == {"msg_1"}
        assert len(store.audit) == 1
        assert store.job("job_2")["status"] == "succeeded"

    async def test_a_redelivered_message_id_does_not_double_write(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        seed_creative(store, media_store, creative_id="cr_2", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_dup")
        # Same message_id, different creative: forces the ledger to be what stops the
        # second write, rather than the already-extracted check doing it by accident.
        store.enqueue(creative_id="cr_2", workspace_id=WORKSPACE, message_id="msg_dup")
        worker = build_worker(store, media_store)

        await drain(worker)
        worker.close()

        assert ("cr_1", FEATURE_SCHEMA_VERSION) in store.features
        assert ("cr_2", FEATURE_SCHEMA_VERSION) not in store.features
        assert len(store.audit) == 1
        # A duplicate is a no-op, not a failure — the work it describes is already done.
        assert store.job("job_2")["status"] == "succeeded"


class TestVersioning:
    async def test_a_version_bump_marks_rows_stale_and_re_extracts(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        assert store.mark_stale(below_version=2) == 1
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=2
        )
        await worker.run_once()
        worker.close()

        # Both rows survive. Keeping v1 is what makes the bump auditable: without it you
        # cannot tell a definition change from a change in the media itself.
        assert store.features[("cr_1", 1)].is_stale is True
        assert store.features[("cr_1", 2)].schema_version == 2

    async def test_a_stale_row_does_not_count_as_already_extracted(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        store.features[("cr_1", 1)].is_stale = True
        assert await store.already_extracted("cr_1", 1) is False
        worker.close()


class TestFailureIsolation:
    async def test_a_corrupt_file_fails_its_job_without_blocking_the_batch(
        self, tmp_path: Path, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(
            store, media_store, creative_id="cr_bad", body=make_corrupt(tmp_path / "b.mp4").read_bytes()
        )
        seed_creative(store, media_store, creative_id="cr_ok", body=video_bytes)
        store.enqueue(creative_id="cr_bad", workspace_id=WORKSPACE, message_id="msg_bad")
        store.enqueue(creative_id="cr_ok", workspace_id=WORKSPACE, message_id="msg_ok")
        worker = build_worker(store, media_store)

        await drain(worker)
        worker.close()

        bad = store.job("job_1")
        assert bad["status"] == "failed"
        assert "cannot open media" in bad["last_error"] or "decodable" in bad["last_error"]
        # Not retried: nothing about a second attempt would make the bytes decode, and the
        # queue is ordered by `run_after`, so a retry would jump ahead of healthy work.
        assert bad["attempts"] == 1
        # The healthy creative in the same batch is unaffected. Spec criterion 3.
        assert ("cr_ok", FEATURE_SCHEMA_VERSION) in store.features
        assert store.job("job_2")["status"] == "succeeded"

    async def test_a_transient_storage_error_is_retried_and_then_succeeds(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        flaky = FlakyMediaStore(media_store, failures=1)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, flaky)

        await drain(worker)
        worker.close()

        # The mirror image of the corrupt-file case: this one *should* come back, and the
        # worker must not treat every failure as permanent just because some are.
        assert store.job("job_1")["attempts"] == 2
        assert store.job("job_1")["status"] == "succeeded"
        assert ("cr_1", FEATURE_SCHEMA_VERSION) in store.features

    async def test_a_missing_creative_is_a_permanent_failure(self) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        store.enqueue(
            creative_id="cr_gone", workspace_id=WORKSPACE, message_id="msg_1", max_attempts=1
        )
        worker = build_worker(store, media_store)

        await worker.run_once()
        worker.close()

        assert store.job("job_1")["status"] == "failed"
        assert "no longer exists" in store.job("job_1")["last_error"]

    async def test_a_creative_with_no_media_url_fails_rather_than_writing_an_empty_row(
        self,
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        store.add_creative(
            Creative(
                id="cr_1",
                workspace_id=WORKSPACE,
                creative_hash="tuple:cr_1",
                media_type="video",
                media_url=None,
            )
        )
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1", max_attempts=1
        )
        worker = build_worker(store, media_store)

        await worker.run_once()
        worker.close()

        assert store.features == {}
        assert "no media_url" in store.job("job_1")["last_error"]


class TestLiveness:
    async def test_heartbeats_continue_during_blocking_extraction(
        self, video_bytes: bytes
    ) -> None:
        """The guard on spec rule 5.

        `SlowMediaStore.get` calls `time.sleep`, exactly as OpenCV occupies a thread. If the
        blocking work ever moves back onto the event loop, the heartbeat coroutine is never
        scheduled, this assertion sees zero heartbeats, and the test fails — which is the
        cheap version of discovering it as a mystery timeout in production.
        """
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(
            store, SlowMediaStore(media_store, delay_s=0.3), heartbeat_interval_s=0.02
        )

        await worker.run_once()
        worker.close()

        assert len(store.heartbeats) >= 5
        assert set(store.heartbeats) == {"job_1"}
        assert store.job("job_1")["status"] == "succeeded"

    def test_the_heartbeat_interval_stays_well_inside_the_reapers_window(self) -> None:
        """Pins a constant in Python against a default in SQL.

        The test above passes an explicit interval, so it proves heartbeats fire during
        blocking work but says nothing about the shipped value. That value only means
        something relative to `app.reap_stalled_jobs`' stall window, which lives in another
        language in another directory. Nothing but this assertion connects them, and if
        they drift the wrong way every healthy extraction gets reaped mid-flight — the
        failure the heartbeat was added to prevent, reintroduced by a one-line edit.

        The window is read from the migration rather than copied, so raising it there
        cannot leave a stale expectation passing here.
        """
        sql = MIGRATION_0004.read_text(encoding="utf-8")
        match = re.search(
            r"stall_after\s+interval\s+default\s+interval\s+'(\d+)\s+minutes?'", sql
        )
        assert match is not None, "reaper stall window not found in 0004_features.sql"
        stall_window_s = int(match.group(1)) * 60

        # 10x, not 2x or 4x. The margin has to absorb *consecutive* missed ticks, and the
        # things that cause them are not brief: a GC pause under a loaded thread pool, a
        # slow claim query, whisper holding the GIL through a long decode. At 4x a job dies
        # after four bad ticks, which is well within what a busy Fly machine produces on an
        # ordinary day. The shipped 15s against a 5-minute window gives 20.
        assert DEFAULT_HEARTBEAT_INTERVAL_S * 10 <= stall_window_s

    async def test_heartbeats_stop_once_the_job_is_done(self, video_bytes: bytes) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store, heartbeat_interval_s=0.01)

        await worker.run_once()
        settled = len(store.heartbeats)
        await drain(worker)
        worker.close()

        # A heartbeat task that outlived its job would keep a finished job invisible to the
        # reaper and, worse, keep the loop alive after shutdown.
        assert len(store.heartbeats) == settled


class TestMediaLanding:
    async def test_re_extraction_reads_storage_and_never_refetches(
        self, video_bytes: bytes, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)

        def explode(url: str, **kwargs: object) -> tuple[bytes, str]:
            raise AssertionError(f"re-extraction must not fetch {url}")

        monkeypatch.setattr(media_module, "fetch", explode)

        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        store.mark_stale(below_version=2)
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=2
        )
        await worker.run_once()
        worker.close()

        # The signed URL is long dead by the time a version bump lands. Storage is the only
        # copy that can still answer, which is why landing is write-once and unconditional.
        assert store.features[("cr_1", 2)].media.reused is True

    async def test_a_fetch_failure_is_permanent_not_a_retry_storm(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        store.add_creative(
            Creative(
                id="cr_1",
                workspace_id=WORKSPACE,
                creative_hash="tuple:cr_1",
                media_type="video",
                media_url="https://cdn.example.test/expired.mp4",
            )
        )

        def expired(url: str, **kwargs: object) -> tuple[bytes, str]:
            raise media_module.MediaFetchError("403 expired signature")

        monkeypatch.setattr(media_module, "fetch", expired)

        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1", max_attempts=1
        )
        worker = build_worker(store, media_store)
        await worker.run_once()
        worker.close()

        assert store.job("job_1")["status"] == "failed"
        assert "expired signature" in store.job("job_1")["last_error"]
