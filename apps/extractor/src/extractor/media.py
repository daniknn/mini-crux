"""Fetching creative media and landing it immutably before extraction.

The same rule as raw crawl snapshots
------------------------------------
Ad Library media URLs are signed and short-lived. If re-extraction re-fetched from the URL
it would, at best, 403 — and at worst quietly return *different bytes* than the ones the
original features were computed from, making a version-over-version comparison meaningless.

So the bytes are landed once, keyed by creative hash, and every later read goes to storage.
`put` refuses to overwrite for the same reason `creative_observations` cannot be updated:
the stored artifact is the evidence behind a number we will still be citing months later.
"""

from __future__ import annotations

import hashlib
import posixpath
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Protocol, runtime_checkable
from urllib.parse import urlparse

DEFAULT_MEDIA_BUCKET = "media"

#: Refuse anything larger. An Ad Library video is a handful of megabytes; a response an
#: order of magnitude past that is a redirect to something we did not ask for, and
#: streaming it into memory on a small Fly machine is how a worker dies mid-batch.
MAX_MEDIA_BYTES = 200 * 1024 * 1024

_EXTENSION_BY_MEDIA_TYPE = {"video": ".mp4", "image": ".jpg"}


class MediaExistsError(RuntimeError):
    """The object is already stored. Landing is write-once."""


class MediaFetchError(RuntimeError):
    """The media could not be retrieved — expired URL, 404, oversized body."""


@runtime_checkable
class MediaStore(Protocol):
    def exists(self, path: str) -> bool: ...

    def put(self, path: str, data: bytes, *, content_type: str) -> None: ...

    def get(self, path: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class LandedMedia:
    path: str
    sha256: str
    size_bytes: int
    reused: bool


def media_path(workspace_id: str, creative_hash: str, media_url: str, media_type: str) -> str:
    """`{workspace}/{safe-hash}{ext}` — keyed by creative, not by ad or by URL.

    The hash may carry a `tuple:` prefix from the ingestion-time identity fallback, which
    is not a legal path segment everywhere, so it is flattened.
    """
    safe_hash = creative_hash.replace(":", "_").replace("/", "_")
    return posixpath.join(workspace_id, f"{safe_hash}{_extension(media_url, media_type)}")


def _extension(media_url: str, media_type: str) -> str:
    suffix = PurePosixPath(urlparse(media_url).path).suffix.lower()
    # Guard against a query-string artefact or a path with no extension masquerading as
    # one; anything unfamiliar falls back to the declared media type.
    if suffix and 2 <= len(suffix) <= 5 and suffix[1:].isalnum():
        return suffix
    return _EXTENSION_BY_MEDIA_TYPE.get(media_type, ".bin")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str, *, timeout_s: float = 60.0) -> tuple[bytes, str]:
    """Download media. Returns (bytes, content_type).

    Streamed with a running size check rather than read whole: a `Content-Length` header
    is a claim, not a guarantee, and the ceiling has to hold even when the server lies.
    """
    import httpx

    try:
        with httpx.stream("GET", url, timeout=timeout_s, follow_redirects=True) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "application/octet-stream")

            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > MAX_MEDIA_BYTES:
                    raise MediaFetchError(f"media exceeds {MAX_MEDIA_BYTES} bytes: {url}")
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise MediaFetchError(f"could not fetch media: {exc}") from exc

    data = b"".join(chunks)
    if not data:
        raise MediaFetchError(f"media is empty: {url}")
    return data, content_type


def land(
    store: MediaStore,
    *,
    workspace_id: str,
    creative_hash: str,
    media_url: str,
    media_type: str,
) -> tuple[LandedMedia, bytes]:
    """Ensure the media is in storage, returning its descriptor and its bytes.

    Idempotent by design: a re-delivered extract job for a creative already landed reads
    the stored object instead of hitting the signed URL again. This is what makes
    re-extraction after a `schema_version` bump possible long after the URL has expired.
    """
    path = media_path(workspace_id, creative_hash, media_url, media_type)

    if store.exists(path):
        data = store.get(path)
        return (
            LandedMedia(path=path, sha256=sha256_hex(data), size_bytes=len(data), reused=True),
            data,
        )

    data, content_type = fetch(media_url)
    try:
        store.put(path, data, content_type=content_type)
    except MediaExistsError:
        # Another worker landed it between our check and our write. Its bytes win — they
        # are the ones any concurrently-written features row was computed from.
        data = store.get(path)

    return (
        LandedMedia(path=path, sha256=sha256_hex(data), size_bytes=len(data), reused=False),
        data,
    )


class MemoryMediaStore:
    """In-process store for tests, with the same write-once contract as the real one."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}

    def exists(self, path: str) -> bool:
        return path in self.objects

    def put(self, path: str, data: bytes, *, content_type: str) -> None:
        if path in self.objects:
            raise MediaExistsError(path)
        self.objects[path] = data
        self.content_types[path] = content_type

    def get(self, path: str) -> bytes:
        if path not in self.objects:
            raise KeyError(path)
        return self.objects[path]


class SupabaseMediaStore:
    """Supabase Storage over its REST surface.

    `x-upsert: false` is the write-once enforcement; Supabase returns 409 on a duplicate,
    which is translated rather than raised as a bare HTTP error so callers can treat "it
    was already there" as the ordinary path it is.
    """

    def __init__(self, url: str, service_role_key: str, bucket: str = DEFAULT_MEDIA_BUCKET) -> None:
        self._base = f"{url.rstrip('/')}/storage/v1/object"
        self._bucket = bucket
        self._headers = {
            "Authorization": f"Bearer {service_role_key}",
            "apikey": service_role_key,
        }

    def _object_url(self, path: str) -> str:
        return f"{self._base}/{self._bucket}/{path}"

    def exists(self, path: str) -> bool:
        import httpx

        response = httpx.head(self._object_url(path), headers=self._headers, timeout=30.0)
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return True

    def put(self, path: str, data: bytes, *, content_type: str) -> None:
        import httpx

        response = httpx.post(
            self._object_url(path),
            headers={**self._headers, "content-type": content_type, "x-upsert": "false"},
            content=data,
            timeout=120.0,
        )
        if response.status_code == 409:
            raise MediaExistsError(path)
        response.raise_for_status()

    def get(self, path: str) -> bytes:
        import httpx

        response = httpx.get(self._object_url(path), headers=self._headers, timeout=120.0)
        response.raise_for_status()
        return response.content
