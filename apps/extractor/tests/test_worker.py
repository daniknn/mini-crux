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
from extractor.media import MemoryMediaStore, media_path, poster_path, semantic_frame_path
from extractor.store import Creative
from extractor.testing import (
    FakeAudio,
    FakeOcr,
    FakeTranscriber,
    FlakyMediaStore,
    MemoryJobStore,
    PosterHostileMediaStore,
    SemanticFrameHostileMediaStore,
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

        # Relative to the shipped version rather than the literal 1 and 2 this used to
        # hard-code. A bump is a routine event — v2 added the poster frame — and a test
        # written against the version numbers of the day fails on the next bump for no
        # reason, which teaches whoever bumps to edit the assertion instead of reading it.
        nxt = FEATURE_SCHEMA_VERSION + 1
        assert store.mark_stale(below_version=nxt) == 1
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=nxt
        )
        await worker.run_once()
        worker.close()

        # Both rows survive. Keeping the older one is what makes a bump auditable: without
        # it you cannot tell a definition change from a change in the media itself.
        assert store.features[("cr_1", FEATURE_SCHEMA_VERSION)].is_stale is True
        assert store.features[("cr_1", nxt)].schema_version == nxt

    async def test_a_stale_row_does_not_count_as_already_extracted(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        store.features[("cr_1", FEATURE_SCHEMA_VERSION)].is_stale = True
        assert await store.already_extracted("cr_1", FEATURE_SCHEMA_VERSION) is False
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

        # Relative to the shipped version, not literal: at a literal 2 this second run became
        # a no-op the moment FEATURE_SCHEMA_VERSION reached 2, and the assertion below is
        # then satisfied by the *first* run — which reused storage only because
        # `seed_creative` pre-landed it. The re-extraction this test is named for would stop
        # happening and nothing would say so.
        nxt = FEATURE_SCHEMA_VERSION + 1
        assert store.mark_stale(below_version=nxt) == 1
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=nxt
        )
        assert await worker.run_once() is True
        worker.close()

        # The signed URL is long dead by the time a version bump lands. Storage is the only
        # copy that can still answer, which is why landing is write-once and unconditional.
        assert store.features[("cr_1", nxt)].media.reused is True

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


class TestPosterUpload:
    """The poster is the one artefact the worker is allowed to lose.

    It is a thumbnail, not a measurement: nothing in UC-5 correlates on it, so a storage
    outage must cost the gallery an image and cost the panel nothing. What it must never do
    is leave `poster_storage_path` pointing at an object that was never written — a null the
    gallery handles and a dangling path it does not.
    """

    def poster_key(self, media_store: MemoryMediaStore) -> str:
        keys = [k for k in media_store.objects if ".poster." in k]
        assert len(keys) == 1, f"expected exactly one poster, got {keys}"
        return keys[0]

    async def test_the_poster_lands_beside_the_media_and_the_row_points_at_it(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        creative = seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)

        await worker.run_once()
        worker.close()

        stored = store.features[("cr_1", FEATURE_SCHEMA_VERSION)]
        expected = poster_path(stored.media.path, FEATURE_SCHEMA_VERSION)

        # The exact key, not "a key": the column is a pointer, and a path the row names but
        # storage does not hold is a broken image everywhere it renders.
        assert stored.features.poster_storage_path == expected
        assert self.poster_key(media_store) == expected
        assert media_store.content_types[expected] == "image/jpeg"
        assert media_store.objects[expected][:2] == b"\xff\xd8"  # JPEG SOI
        assert "poster_storage_path" not in stored.features.skipped_features
        assert creative.id == "cr_1"

    async def test_the_poster_key_carries_the_schema_version(self, video_bytes: bytes) -> None:
        """Otherwise a re-extraction hits write-once and keeps the *old* definition's frame.

        The poster path is derived from the media path, which does not change between
        versions. Without the version in the key, a v3 re-extraction would `put` to a key
        that already holds the v2 image, `land_poster` would swallow the refusal as the
        ordinary race it usually is, and the row would point at a poster cut under a
        definition it no longer describes — the exact silent-mixing failure
        FEATURE_SCHEMA_VERSION exists to prevent.
        """
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        first = self.poster_key(media_store)

        nxt = FEATURE_SCHEMA_VERSION + 1
        store.mark_stale(below_version=nxt)
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=nxt
        )
        await worker.run_once()
        worker.close()

        second = store.features[("cr_1", nxt)].features.poster_storage_path
        assert second != first
        assert second == poster_path(store.features[("cr_1", nxt)].media.path, nxt)
        assert second in media_store.objects

    async def test_a_storage_outage_leaves_a_null_and_a_skip_not_a_dangling_path(
        self, video_bytes: bytes
    ) -> None:
        store, inner = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, inner, creative_id="cr_1", body=video_bytes)
        media_store = PosterHostileMediaStore(inner)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)

        assert await worker.run_once() is True
        worker.close()

        assert media_store.refused == 1
        assert store.job("job_1")["status"] == "succeeded"

        stored = store.features[("cr_1", FEATURE_SCHEMA_VERSION)]
        # Null *and* skipped: the pair is what tells the gallery this creative has no image
        # rather than an image that failed to load, and keeps it out of any n computed over
        # posters. A path here would name an object the refusal above proves does not exist.
        assert stored.features.poster_storage_path is None
        assert "poster_storage_path" in stored.features.skipped_features
        assert not any(".poster." in k for k in inner.objects)

        # Everything the panel actually correlates on survived the outage untouched.
        assert stored.features.duration_s == pytest.approx(3.0, abs=0.05)
        assert stored.features.cuts_per_second is not None
        assert stored.features.text_density is not None
        assert stored.features.skipped_features == ["poster_storage_path"]

    async def test_a_poster_already_in_storage_is_not_an_error(self, video_bytes: bytes) -> None:
        """Two workers on one creative encode the same frame to the same key.

        A reaped job that was in fact still healthy is the ordinary way it happens. The
        second writer losing the race must still finish its job and still record the path —
        the bytes it would have written are the bytes already there.
        """
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        expected = self.poster_key(media_store)
        media_store.objects[expected] = b"\xff\xd8 written by the other worker"

        nxt = FEATURE_SCHEMA_VERSION + 1
        store.mark_stale(below_version=nxt)
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=nxt
        )
        # Re-point the v(n+1) key at an existing object so the second run loses the race.
        media_store.objects[
            poster_path(media_path(WORKSPACE, "tuple:cr_1", "https://x/ad.mp4", "video"), nxt)
        ] = b"\xff\xd8 squatted"
        assert await worker.run_once() is True
        worker.close()

        row = store.features[("cr_1", nxt)]
        assert row.features.poster_storage_path is not None
        assert "poster_storage_path" not in row.features.skipped_features


class TestSemanticFrameUpload:
    """The three semantic frames, uploaded and recorded the same way the poster is.

    One difference from the poster worth stating up front: `semantic_frame_paths` is one
    array column, so a partial failure (two of three frames land, one doesn't) is a skip
    for the whole feature — never a shorter array pointing at objects that do not all
    exist. `_store_semantic_frames` enforces that; these tests prove it end to end.
    """

    def semantic_keys(self, media_store: MemoryMediaStore) -> list[str]:
        keys = sorted(k for k in media_store.objects if ".semantic." in k)
        assert len(keys) == 3, f"expected exactly three semantic frames, got {keys}"
        return keys

    async def test_the_frames_land_beside_the_media_and_the_row_points_at_them(
        self, video_bytes: bytes
    ) -> None:
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)

        await worker.run_once()
        worker.close()

        stored = store.features[("cr_1", FEATURE_SCHEMA_VERSION)]
        expected = [
            semantic_frame_path(stored.media.path, FEATURE_SCHEMA_VERSION, index)
            for index in range(3)
        ]

        # The exact three keys in order, not "three keys somewhere": the tagging job reads
        # index 0/1/2 as hook/midpoint/near-end, so the array order is part of the contract.
        assert stored.features.semantic_frame_paths == expected
        assert self.semantic_keys(media_store) == sorted(expected)
        for key in expected:
            assert media_store.content_types[key] == "image/jpeg"
            assert media_store.objects[key][:2] == b"\xff\xd8"  # JPEG SOI
        assert "semantic_frame_paths" not in stored.features.skipped_features

    async def test_the_frame_keys_carry_the_schema_version(self, video_bytes: bytes) -> None:
        """Same reasoning as the poster: without the version, a re-extraction's `put` would
        hit write-once against the prior version's frames and silently keep the old ones."""
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        first = self.semantic_keys(media_store)

        nxt = FEATURE_SCHEMA_VERSION + 1
        store.mark_stale(below_version=nxt)
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=nxt
        )
        await worker.run_once()
        worker.close()

        second = store.features[("cr_1", nxt)].features.semantic_frame_paths
        assert second is not None
        assert set(second).isdisjoint(first)
        assert second == [
            semantic_frame_path(store.features[("cr_1", nxt)].media.path, nxt, index)
            for index in range(3)
        ]
        assert all(path in media_store.objects for path in second)

    async def test_a_storage_outage_leaves_a_null_and_a_skip_not_a_partial_array(
        self, video_bytes: bytes
    ) -> None:
        store, inner = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, inner, creative_id="cr_1", body=video_bytes)
        media_store = SemanticFrameHostileMediaStore(inner)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)

        assert await worker.run_once() is True
        worker.close()

        # The hostile store refuses every `.semantic.` put, so the very first of the three
        # uploads fails — this is the all-or-nothing case, not merely "at least one failed".
        assert media_store.refused == 1
        assert store.job("job_1")["status"] == "succeeded"

        stored = store.features[("cr_1", FEATURE_SCHEMA_VERSION)]
        assert stored.features.semantic_frame_paths is None
        assert "semantic_frame_paths" in stored.features.skipped_features
        assert not any(".semantic." in k for k in inner.objects)

        # The poster and every measured feature survived a failure confined to frame
        # sampling — the outage cost one column, not the row.
        assert stored.features.poster_storage_path is not None
        assert stored.features.duration_s == pytest.approx(3.0, abs=0.05)
        assert stored.features.cuts_per_second is not None
        assert stored.features.skipped_features == ["semantic_frame_paths"]

    async def test_frames_already_in_storage_are_not_an_error(self, video_bytes: bytes) -> None:
        """Two workers on one creative encode the same three frames to the same three keys.

        Same race as the poster: the second writer to land loses `put` but must still
        finish the job and still record all three paths, because the bytes it would have
        written are the bytes already there — the frame is deterministic per schema version.
        """
        store, media_store = MemoryJobStore(), MemoryMediaStore()
        seed_creative(store, media_store, creative_id="cr_1", body=video_bytes)
        store.enqueue(creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_1")
        worker = build_worker(store, media_store)
        await worker.run_once()

        expected = self.semantic_keys(media_store)
        for key in expected:
            media_store.objects[key] = b"\xff\xd8 written by the other worker"

        nxt = FEATURE_SCHEMA_VERSION + 1
        store.mark_stale(below_version=nxt)
        store.enqueue(
            creative_id="cr_1", workspace_id=WORKSPACE, message_id="msg_2", schema_version=nxt
        )
        media_path_value = media_path(WORKSPACE, "tuple:cr_1", "https://x/ad.mp4", "video")
        for index in range(3):
            media_store.objects[semantic_frame_path(media_path_value, nxt, index)] = (
                b"\xff\xd8 squatted"
            )
        assert await worker.run_once() is True
        worker.close()

        row = store.features[("cr_1", nxt)]
        assert row.features.semantic_frame_paths is not None
        assert len(row.features.semantic_frame_paths) == 3
        assert "semantic_frame_paths" not in row.features.skipped_features
