"""Delegated Entra tokens presented directly to /mcp.

The ``AzureProvider`` only accepts tokens it issued itself during a browser
sign-in. ``_build_delegated_verifier`` adds a plain ``JWTVerifier`` for tokens a
trusted backend obtained for the user via On-Behalf-Of. These tests exercise
that verifier with a static keypair (no JWKS, no network, no database).
"""
from __future__ import annotations

import uuid

import pytest
from fastmcp.server.auth.providers.jwt import RSAKeyPair

from src import auth

TENANT = "11111111-1111-1111-1111-111111111111"
CLIENT_ID = "22222222-2222-2222-2222-222222222222"
ISSUER = f"https://login.microsoftonline.com/{TENANT}/v2.0"


@pytest.fixture(scope="module")
def keypair() -> RSAKeyPair:
    return RSAKeyPair.generate()


def _verifier(kp: RSAKeyPair) -> auth.JWTVerifier:
    # Same shape as _build_delegated_verifier, keyed on a static public key.
    return auth.JWTVerifier(
        public_key=kp.public_key,
        issuer=ISSUER,
        audience=[CLIENT_ID, f"api://{CLIENT_ID}"],
        algorithm="RS256",
        required_scopes=["access"],
    )


def _user_token(
    kp: RSAKeyPair, *, scp: str | None = "access", aud: str = f"api://{CLIENT_ID}"
) -> str:
    oid = str(uuid.uuid4())
    claims: dict = {"oid": oid, "preferred_username": "user@example.com", "name": "User"}
    if scp is not None:
        claims["scp"] = scp
    return kp.create_token(subject=oid, issuer=ISSUER, audience=aud, additional_claims=claims)


async def test_accepts_delegated_user_token(keypair):
    result = await _verifier(keypair).load_access_token(_user_token(keypair))
    assert result is not None
    assert "access" in result.scopes
    assert result.claims.get("preferred_username") == "user@example.com"


async def test_rejects_token_without_scope(keypair):
    assert await _verifier(keypair).load_access_token(_user_token(keypair, scp=None)) is None


async def test_rejects_token_with_other_scope(keypair):
    assert await _verifier(keypair).load_access_token(_user_token(keypair, scp="other")) is None


async def test_rejects_wrong_audience(keypair):
    tok = _user_token(keypair, aud="api://some-other-app")
    assert await _verifier(keypair).load_access_token(tok) is None


def test_build_requires_app_config(monkeypatch):
    monkeypatch.setattr(auth.config, "AZURE_TENANT_ID", "")
    assert auth._build_delegated_verifier() is None


def test_build_uses_app_scope_and_audiences(monkeypatch):
    monkeypatch.setattr(auth.config, "AZURE_TENANT_ID", TENANT)
    monkeypatch.setattr(auth.config, "AZURE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(auth.config, "AZURE_API_AUDIENCE", f"api://{CLIENT_ID}")
    monkeypatch.setattr(auth.config, "MCP_SCOPES", [])
    v = auth._build_delegated_verifier()
    assert v is not None
    assert v.required_scopes == ["access"]
    assert v.audience == [CLIENT_ID, f"api://{CLIENT_ID}"]


def test_dev_mode_builds_no_auth(monkeypatch):
    monkeypatch.setattr(auth.config, "AUTH_MODE", "dev")
    assert auth.build_mcp_auth() is None
