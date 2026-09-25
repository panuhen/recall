"""Embeddings over HTTP — Azure OpenAI or any OpenAI-compatible server.

There is no in-process model: a thin ``httpx`` client POSTs a batch of texts to
the configured provider (``config.EMBEDDING_PROVIDER``) and reads back
``data[].embedding``.

- ``azure``: the endpoint env var is a full deployment URL (``…/deployments/
  <model>/embeddings?api-version=…``); auth is the ``api-key`` header, and
  ``dimensions`` is always sent.
- ``openai``: ``POST {EMBEDDING_BASE_URL}/embeddings`` with ``model`` in the body
  — OpenAI itself, or a self-hosted server with the same API (Ollama's /v1,
  vLLM, HF TEI, LiteLLM). ``Authorization: Bearer`` is sent only when
  ``EMBEDDING_API_KEY`` is set, and ``dimensions`` per
  ``EMBEDDING_SEND_DIMENSIONS``.

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
# note can never 400 the call. Self-hosted models may have a shorter context
# window; whether the server then truncates or rejects depends on the server.
_MAX_INPUT_CHARS = 24_000

# Small batch — in practice each embed job sends a single note, so this only
# matters if a future path embeds many texts at once.
_BATCH = 16

_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)


class EmbeddingError(RuntimeError):
    """Embedding could not be produced (network, auth, rate-limit, bad vector)."""


def embedding_model() -> str:
    """The model name for the active provider. For azure the deployment URL
    decides the real model; this name only feeds the content hash."""
    if config.EMBEDDING_PROVIDER == "azure":
        return config.AZURE_OPENAI_EMBEDDING_MODEL
    return config.EMBEDDING_MODEL


def _send_dimensions() -> bool:
    """Whether the openai provider sends ``dimensions``. ``auto`` sends it only
    to OpenAI's text-embedding-3* models (Matryoshka, so they can shorten);
    self-hosted models often reject or ignore the param. A routing prefix such
    as LiteLLM's ``openai/text-embedding-3-large`` still counts."""
    mode = config.EMBEDDING_SEND_DIMENSIONS
    if mode == "auto":
        return config.EMBEDDING_MODEL.rsplit("/", 1)[-1].startswith("text-embedding-3")
    return mode == "true"


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
    the worker can skip a redundant re-embed. Switching model or dim changes
    every hash, so the startup backfill re-embeds every note. The key format is
    unchanged from the Azure-only version, so existing Azure vectors stay valid."""
    key = f"{embedding_model()}|{config.EMBEDDING_DIM}|{text}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _validate(vec: list[float]) -> list[float]:
    """Reject dimension mismatch / non-finite / zero vectors. A zero or NaN
    vector poisons cosine ranking (distance to everything degenerates), so we
    fail loudly and let the caller retry rather than store poison."""
    if len(vec) != config.EMBEDDING_DIM:
        raise EmbeddingError(f"expected {config.EMBEDDING_DIM} dims, got {len(vec)}")
    if not all(math.isfinite(x) for x in vec):
        raise EmbeddingError("non-finite value in embedding")
    if sum(x * x for x in vec) < 1e-12:
        raise EmbeddingError("degenerate (zero-magnitude) embedding")
    return vec


def _request() -> tuple[str, dict[str, str], dict]:
    """URL, headers and the non-``input`` body fields for the active provider."""
    provider = config.EMBEDDING_PROVIDER
    headers = {"content-type": "application/json"}
    if provider == "azure":
        if not (config.AZURE_OPENAI_EMBEDDING_ENDPOINT and config.AZURE_OPENAI_API_KEY):
            raise EmbeddingError("Azure OpenAI endpoint/key not configured")
        headers["api-key"] = config.AZURE_OPENAI_API_KEY
        return (
            config.AZURE_OPENAI_EMBEDDING_ENDPOINT,
            headers,
            {"dimensions": config.EMBEDDING_DIM},
        )
    if provider == "openai":
        if config.EMBEDDING_API_KEY:
            headers["authorization"] = f"Bearer {config.EMBEDDING_API_KEY}"
        body: dict = {"model": config.EMBEDDING_MODEL}
        if _send_dimensions():
            body["dimensions"] = config.EMBEDDING_DIM
        return f"{config.EMBEDDING_BASE_URL.rstrip('/')}/embeddings", headers, body
    raise EmbeddingError(f"unsupported EMBEDDING_PROVIDER={provider!r}")


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts, preserving input order. Raises ``EmbeddingError``
    on any failure so the caller (a retrying background task) can back off."""
    if not texts:
        return []
    url, headers, extra = _request()
    provider = config.EMBEDDING_PROVIDER

    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for i in range(0, len(texts), _BATCH):
            chunk = texts[i : i + _BATCH]
            try:
                r = await client.post(url, headers=headers, json={"input": chunk, **extra})
            except httpx.HTTPError as exc:
                raise EmbeddingError(f"request failed: {exc}") from exc
            if r.status_code != 200:
                raise EmbeddingError(f"{provider} {r.status_code}: {r.text[:200]}")
            try:
                # Response order isn't guaranteed — sort by the echoed index.
                data = sorted(r.json()["data"], key=lambda d: d["index"])
                vecs = [list(d["embedding"]) for d in data]
            except (ValueError, KeyError, TypeError) as exc:
                raise EmbeddingError(f"{provider}: malformed response: {exc!r}") from exc
            if len(vecs) != len(chunk):
                raise EmbeddingError(
                    f"{provider}: sent {len(chunk)} inputs, got {len(vecs)} embeddings"
                )
            out.extend(_validate(v) for v in vecs)
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
