"""Media landing: pathing, write-once, and the reuse that makes re-extraction possible."""

from __future__ import annotations

import pytest

from extractor import media as media_module
from extractor.media import (
    MediaExistsError,
    MediaFetchError,
    MemoryMediaStore,
    land,
    media_path,
    sha256_hex,
)

WORKSPACE = "ws-1"


class TestPathing:
    def test_the_path_is_keyed_by_creative_not_by_url(self) -> None:
        # Ad Library URLs are signed and rotate between crawls. A path derived from one
        # would land the same creative under a new key every day, so re-extraction would
        # never find the earlier bytes and the store would grow without bound.
        first = media_path(WORKSPACE, "tuple:abc", "https://cdn.test/v.mp4?sig=aaa", "video")
        second = media_path(WORKSPACE, "tuple:abc", "https://cdn.test/v.mp4?sig=bbb", "video")
        assert first == second

    def test_the_hash_prefix_is_flattened_into_a_legal_segment(self) -> None:
        assert media_path(WORKSPACE, "tuple:abc", "https://cdn.test/v.mp4", "video") == (
            "ws-1/tuple_abc.mp4"
        )

    @pytest.mark.parametrize(
        ("url", "media_type", "expected"),
        [
            ("https://cdn.test/a.mp4", "video", ".mp4"),
            ("https://cdn.test/a.jpg?x=1", "image", ".jpg"),
            ("https://cdn.test/no-extension", "video", ".mp4"),
            ("https://cdn.test/weird.somethinglong", "image", ".jpg"),
            ("https://cdn.test/a.webm", "video", ".webm"),
        ],
    )
    def test_extension_falls_back_to_the_declared_media_type(
        self, url: str, media_type: str, expected: str
    ) -> None:
        assert media_path(WORKSPACE, "h", url, media_type).endswith(expected)

    def test_two_workspaces_tracking_the_same_creative_do_not_share_an_object(self) -> None:
        a = media_path("ws-a", "tuple:abc", "https://cdn.test/v.mp4", "video")
        b = media_path("ws-b", "tuple:abc", "https://cdn.test/v.mp4", "video")
        assert a != b


class TestLanding:
    def test_landing_fetches_once_and_reuses_thereafter(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = MemoryMediaStore()
        calls: list[str] = []

        def fake_fetch(url: str, **kwargs: object) -> tuple[bytes, str]:
            calls.append(url)
            return b"video-bytes", "video/mp4"

        monkeypatch.setattr(media_module, "fetch", fake_fetch)

        landed, data = land(
            store,
            workspace_id=WORKSPACE,
            creative_hash="tuple:abc",
            media_url="https://cdn.test/v.mp4",
            media_type="video",
        )
        assert landed.reused is False
        assert data == b"video-bytes"
        assert landed.sha256 == sha256_hex(b"video-bytes")

        again, _ = land(
            store,
            workspace_id=WORKSPACE,
            creative_hash="tuple:abc",
            media_url="https://cdn.test/v.mp4?rotated=1",
            media_type="video",
        )
        assert again.reused is True
        assert again.sha256 == landed.sha256
        assert calls == ["https://cdn.test/v.mp4"]

    def test_the_store_refuses_to_overwrite(self) -> None:
        store = MemoryMediaStore()
        store.put("a/b.mp4", b"first", content_type="video/mp4")
        # Same contract as raw crawl snapshots: the stored artifact is the evidence behind
        # a number we will still be citing months from now.
        with pytest.raises(MediaExistsError):
            store.put("a/b.mp4", b"second", content_type="video/mp4")
        assert store.get("a/b.mp4") == b"first"

    def test_a_concurrent_landing_yields_the_bytes_that_won(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = MemoryMediaStore()
        path = media_path(WORKSPACE, "tuple:abc", "https://cdn.test/v.mp4", "video")

        def fetch_then_race(url: str, **kwargs: object) -> tuple[bytes, str]:
            # Simulates another worker landing the object between our exists() check and
            # our put(). Its bytes are the ones any concurrently-written features row was
            # computed from, so they must win.
            store.put(path, b"winner", content_type="video/mp4")
            return b"loser", "video/mp4"

        monkeypatch.setattr(media_module, "fetch", fetch_then_race)

        landed, data = land(
            store,
            workspace_id=WORKSPACE,
            creative_hash="tuple:abc",
            media_url="https://cdn.test/v.mp4",
            media_type="video",
        )
        assert data == b"winner"
        assert landed.sha256 == sha256_hex(b"winner")

    def test_a_fetch_failure_propagates(self, monkeypatch: pytest.MonkeyPatch) -> None:
        store = MemoryMediaStore()

        def expired(url: str, **kwargs: object) -> tuple[bytes, str]:
            raise MediaFetchError("403")

        monkeypatch.setattr(media_module, "fetch", expired)

        with pytest.raises(MediaFetchError):
            land(
                store,
                workspace_id=WORKSPACE,
                creative_hash="tuple:abc",
                media_url="https://cdn.test/v.mp4",
                media_type="video",
            )
        assert store.objects == {}
