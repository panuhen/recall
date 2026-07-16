"""Azure OpenAI embeddings — the only provider (no local model).

A thin ``httpx`` client against an Azure OpenAI *embeddings* deployment. The
endpoint env var is a full deployment URL (``…/deployments/<model>/embeddings?
api-version=…``), so we POST the batch straight to it with the ``api-key``
header and read back ``data[].embedding``.

The note write-path never blocks on this: notes are embedded asynchronously by
the ``embed_note`` background task (``src/tasks.py``). Only the search endpoint
calls it inline — to embed the query — and falls back to keyword-only search if
it fails.
"""
from __future__ import annotations

import hashlib
import logging
import math

import httpx

from . import config
from .markdown import parse_frontmatter

log = logging.getLogger("recall.embeddings")

# text-embedding-3-large accepts 8191 tokens. Truncate the embed input to a
# generous character budget (~4 chars/token ⇒ well under the limit) so a huge
# note can never 400 the call.
_MAX_INPUT_CHARS = 24_000

# Small batch — in practice each embed job sends a single note, so this only
# matters if a future path embeds many texts at once.
_BATCH = 16

_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)


class EmbeddingError(RuntimeError):
    """Embedding could not be produced (network, auth, rate-limit, bad vector)."""


def build_embed_text(
    title: str,
    body: str,
    tags: list[str] | None = None,
    type_: str | None = None,
) -> str:
    """The string we embed for a note: a small typed header + title + content.

    Frontmatter is stripped (its projected fields go in the header instead) so
    the vector reflects meaning, not YAML syntax.
    """
    _, content = parse_frontmatter(body)
    header_bits = []
    if type_:
        header_bits.append(type_)
    if tags:
        header_bits.append(" ".join(tags))
    header = " / ".join(header_bits)
    parts = [p for p in (header, title, content.strip()) if p]
    return "\n".join(parts)[:_MAX_INPUT_CHARS]


def content_hash(text: str) -> str:
    """Idempotency key: identical embed-input + model/dim ⇒ identical hash ⇒
    the worker can skip a redundant re-embed."""
    key = f"{config.AZURE_OPENAI_EMBEDDING_MODEL}|{config.AZURE_OPENAI_EMBEDDING_DIM}|{text}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _validate(vec: list[float]) -> list[float]:
    """Reject dimension mismatch / non-finite / zero vectors. A zero or NaN
    vector poisons cosine ranking (distance to everything degenerates), so we
    fail loudly and let the caller retry rather than store poison."""
    if len(vec) != config.AZURE_OPENAI_EMBEDDING_DIM:
        raise EmbeddingError(
            f"expected {config.AZURE_OPENAI_EMBEDDING_DIM} dims, got {len(vec)}"
        )
    if not all(math.isfinite(x) for x in vec):
        raise EmbeddingError("non-finite value in embedding")
    if sum(x * x for x in vec) < 1e-12:
        raise EmbeddingError("degenerate (zero-magnitude) embedding")
    return vec


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts, preserving input order. Raises ``EmbeddingError``
    on any failure so the caller (a retrying background task) can back off."""
    if not texts:
        return []
    if config.EMBEDDING_PROVIDER != "azure":
        raise EmbeddingError(f"unsupported EMBEDDING_PROVIDER={config.EMBEDDING_PROVIDER!r}")
    if not (config.AZURE_OPENAI_EMBEDDING_ENDPOINT and config.AZURE_OPENAI_API_KEY):
        raise EmbeddingError("Azure OpenAI endpoint/key not configured")

    headers = {
        "api-key": config.AZURE_OPENAI_API_KEY,
        "content-type": "application/json",
    }
    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for i in range(0, len(texts), _BATCH):
            chunk = texts[i : i + _BATCH]
            try:
                r = await client.post(
                    config.AZURE_OPENAI_EMBEDDING_ENDPOINT,
                    headers=headers,
                    json={
                        "input": chunk,
                        "dimensions": config.AZURE_OPENAI_EMBEDDING_DIM,
                    },
                )
            except httpx.HTTPError as exc:
                raise EmbeddingError(f"request failed: {exc}") from exc
            if r.status_code != 200:
                raise EmbeddingError(f"azure {r.status_code}: {r.text[:200]}")
            # Response order isn't guaranteed — sort by the echoed index.
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            out.extend(_validate(list(d["embedding"])) for d in data)
    return out


async def embed_query(text: str) -> list[float] | None:
    """Embed a search query. Returns ``None`` on failure so search can fall back
    to keyword-only (rather than erroring the whole request)."""
    text = text.strip()
    if not text:
        return None
    try:
        vecs = await embed_texts([text[:_MAX_INPUT_CHARS]])
    except EmbeddingError as exc:
        log.warning("query embedding failed, falling back to keyword: %s", exc)
        return None
    return vecs[0] if vecs else None


def to_pgvector(vec: list[float]) -> str:
    """Format a vector as a pgvector literal for a ``$n::vector`` text bind."""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"
