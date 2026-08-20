"""Raw-bytes responses and the cache tag every numeric route in this app
shares -- the mesh routes here, and the field and statistic routes Plan
05-06 adds after this one.

``blob_response`` reports each array's dtype with ``array.dtype.str``, the
endianness-explicit spelling (``<f4``, not ``f4``) that the cache's own
``mesh.json`` already writes. SERVE-01 promises *little-endian* bytes, and a
dtype string with no byte order does not say so -- this is a deliberate
divergence from 05-RESEARCH.md's code example, which strips the marker.

``cache_tag`` and ``cache_headers`` are the whole caching contract, and this
is the one place it is decided: a resource may be marked permanently
cacheable only while the client asks for it by the tag the server currently
holds. The tag is built from facts already recorded in the manifest --
``cache_version`` plus the artifact's recorded file sizes -- so a re-ingest
(new sizes) or a ``CACHE_VERSION`` bump (D-08's hard reset) both change it,
and a client holding an old tag stops matching. A mismatch never refuses:
it serves the current bytes and tells the browser not to keep them, because
a client that guessed a stale tag still deserves the right answer.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np
from starlette.responses import Response

from pesto.cache.manifest import Manifest


def blob_response(
    array: np.ndarray,
    *,
    meta: dict[str, Any] | None = None,
    cache_control: str | None = None,
    etag: str | None = None,
) -> Response:
    """Serve ``array`` as raw bytes with an ``X-Pesto-Meta`` header describing
    its shape and dtype -- the one response builder every numeric route in
    this app uses, so the wire contract is written once.

    The body is ``np.ascontiguousarray(array).tobytes()`` in C order, so a
    transposed or otherwise non-contiguous array is still served as bytes
    that match the shape reported alongside them -- the header never
    describes a layout the bytes do not have.
    """
    contiguous = np.ascontiguousarray(array)
    header: dict[str, Any] = {
        "shape": list(contiguous.shape),
        "dtype": contiguous.dtype.str,
    }
    if meta:
        header.update(meta)

    headers: dict[str, str] = {"X-Pesto-Meta": json.dumps(header, separators=(",", ":"))}
    if cache_control is not None:
        headers["Cache-Control"] = cache_control
    if etag is not None:
        headers["ETag"] = f'"{etag}"'

    return Response(
        content=contiguous.tobytes(),
        media_type="application/octet-stream",
        headers=headers,
    )


def cache_tag(manifest: Manifest, artifact_name: str) -> str | None:
    """The tag that changes exactly when the bytes under ``artifact_name``'s
    URL would change.

    Returns ``None`` when the manifest holds no artifact of that name, or
    when the artifact's recorded state is not ``"ok"`` -- an absent or
    failed artifact has no cacheable bytes, so it has no tag either.

    Built from ``manifest.cache_version`` and the artifact's recorded
    ``CacheFile`` entries as ``(path, bytes)`` pairs in recorded order,
    hashed with sha256 and truncated to 16 hex characters -- never from the
    file contents, which would mean reading every buffer just to decide
    whether a browser may keep its old copy.

    A re-ingest rewrites an artifact's files and their recorded sizes, so
    the tag changes with it. A ``CACHE_VERSION`` bump changes
    ``manifest.cache_version`` for every artifact at once (D-08: a version
    bump is a hard reset, outranking size, mtime and checksum alike), so it
    invalidates every tag in one stroke.
    """
    artifact = manifest.artifacts.get(artifact_name)
    if artifact is None or artifact.state != "ok":
        return None

    fingerprint = [manifest.cache_version, [[f.path, f.bytes] for f in artifact.files]]
    digest = hashlib.sha256(json.dumps(fingerprint).encode()).hexdigest()
    return digest[:16]


def cache_headers(tag: str | None, requested: str | None) -> dict[str, str]:
    """Decide whether a browser may keep the bytes it is about to receive.

    The route always serves the current bytes; this only decides what the
    browser is told about keeping them. When ``tag`` exists and matches
    ``requested`` -- the client already holds bytes for exactly this
    version -- the response is marked permanently cacheable, since a
    changed ``tag`` means a new URL query, never new bytes at the old one.
    Any other case -- a stale ``requested``, no ``requested`` at all, or no
    ``tag`` because the artifact is not ``"ok"`` -- is marked not to be
    stored: the client either has no cached copy yet or has one that must
    not be trusted, and it is told so rather than refused.
    """
    if tag is not None and requested == tag:
        return {
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{tag}"',
        }
    if tag is not None:
        return {"Cache-Control": "no-store", "ETag": f'"{tag}"'}
    return {"Cache-Control": "no-store"}
