"""re:call-branded OAuth consent + error pages.

FastMCP's `OAuthProxy` (which our `AzureProvider` extends) renders the browser
consent screen and any OAuth error pages itself, from hardcoded HTML/CSS in
`fastmcp.server.auth.oauth_proxy.ui`. There is no supported hook to supply
custom markup, so we re-skin the two page builders and swap them in by name.

`_show_consent_page` and the proxy's callback handler resolve `create_consent_html`
/ `create_error_html` from their own module globals at call time, so replacing
those names (see `apply_recall_oauth_branding`) is enough — we don't touch, copy,
or fork any of the OAuth flow, cookie, or CSRF logic. Our replacements keep the
exact call signatures and, critically, the exact form contract the POST handler
reads back: hidden `txn_id` / `csrf_token` / `submit` fields and `action` buttons
valued `approve` / `deny`.

The re:call mark is inlined as SVG rather than an <img>, so it renders under the
page's strict CSP (no `img-src` host needed) and adapts to the viewer's light/dark
theme like the app's favicon does.
"""
from __future__ import annotations

import html as _html
from urllib.parse import urlparse

# The re:call triangle mark (retrieval notch), from web static favicon.svg.
# `currentColor` lets it inherit the themed foreground token.
_MARK_PATH = (
    "M12.00,0.94 L23.70,22.00 L5.45,22.00 L6.56,20.00 L20.30,20.00 "
    "L12.00,5.06 L2.59,22.00 L0.30,22.00Z"
)

_SANS = (
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
)
_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

# Design tokens mirrored from web/src/app/globals.css (oklch, grayscale brand).
# Light values live in :root; the dark block overrides via prefers-color-scheme,
# since this standalone page has no theme toggle.
_TOKENS_CSS = """
    :root {
        color-scheme: light;
        --radius: 0.625rem;
        --bg: oklch(0.985 0 0);
        --card: oklch(1 0 0);
        --fg: oklch(0.145 0 0);
        --muted-fg: oklch(0.556 0 0);
        --border: oklch(0.922 0 0);
        --muted: oklch(0.97 0 0);
        --primary: oklch(0.205 0 0);
        --primary-fg: oklch(0.985 0 0);
        --secondary: oklch(0.97 0 0);
        --secondary-fg: oklch(0.205 0 0);
        --ok: oklch(0.6 0.13 155);
        --destructive: oklch(0.577 0.245 27.325);
    }
    @media (prefers-color-scheme: dark) {
        :root {
            color-scheme: dark;
            --bg: oklch(0.13 0 0);
            --card: oklch(0.22 0 0);
            --fg: oklch(0.985 0 0);
            --muted-fg: oklch(0.708 0 0);
            --border: oklch(1 0 0 / 12%);
            --muted: oklch(0.269 0 0);
            --primary: oklch(0.922 0 0);
            --primary-fg: oklch(0.205 0 0);
            --secondary: oklch(0.269 0 0);
            --secondary-fg: oklch(0.985 0 0);
            --ok: oklch(0.72 0.14 155);
            --destructive: oklch(0.704 0.191 22.216);
        }
    }
"""

_BASE_CSS = """
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
        font-family: %(sans)s;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1.25rem;
        padding: 2rem 1rem;
        background: var(--bg);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
        line-height: 1.5;
    }

    .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 2.5rem 2.25rem;
        max-width: 26rem;
        width: 100%%;
        text-align: center;
    }

    @media (max-width: 480px) {
        .card { padding: 2rem 1.5rem; }
    }

    .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 1.75rem;
    }
    .brand svg { width: 26px; height: 26px; display: block; color: var(--fg); }
    .brand .word {
        font-size: 1.0625rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--fg);
    }

    h1 {
        font-size: 1.375rem;
        font-weight: 600;
        letter-spacing: -0.02em;
        margin-bottom: 0.5rem;
        color: var(--fg);
    }

    .lede {
        font-size: 0.9375rem;
        color: var(--muted-fg);
        margin-bottom: 1.5rem;
    }
    .lede strong { color: var(--fg); font-weight: 600; }

    .scopes {
        list-style: none;
        text-align: left;
        margin-bottom: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
    }
    .scopes li {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        font-size: 0.875rem;
        padding: 0.625rem 0.875rem;
        border: 1px solid var(--border);
        border-radius: calc(var(--radius) - 3px);
        color: var(--fg);
        background: var(--card);
    }
    .scopes .dot {
        width: 5px; height: 5px; border-radius: 50%%;
        background: var(--muted-fg); flex-shrink: 0;
    }

    .callout {
        text-align: left;
        background: var(--muted);
        border: 1px solid var(--border);
        border-radius: calc(var(--radius) - 3px);
        padding: 0.75rem 0.875rem;
        margin-bottom: 1.25rem;
    }
    .callout .label {
        display: block;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted-fg);
        margin-bottom: 0.25rem;
    }
    .callout .value {
        font-family: %(mono)s;
        font-size: 0.8125rem;
        color: var(--fg);
        word-break: break-all;
    }

    .badge {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.8125rem;
        color: var(--muted-fg);
        margin-bottom: 1.25rem;
    }
    .badge .check { color: var(--ok); font-weight: 700; }
    .badge strong { color: var(--fg); font-weight: 600; }

    details {
        text-align: left;
        margin-bottom: 1.5rem;
        border-top: 1px solid var(--border);
        padding-top: 0.75rem;
    }
    summary {
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--muted-fg);
        list-style: none;
        display: flex;
        align-items: center;
        gap: 0.375rem;
    }
    summary::-webkit-details-marker { display: none; }
    summary::before {
        content: "\\203A";
        display: inline-block;
        transition: transform 0.15s ease;
        font-size: 1rem;
        line-height: 1;
    }
    details[open] summary::before { transform: rotate(90deg); }
    .rows { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .row { display: flex; gap: 0.75rem; font-size: 0.8125rem; }
    .row .k { color: var(--muted-fg); min-width: 8.5rem; flex-shrink: 0; }
    .row .v {
        font-family: %(mono)s;
        font-size: 0.75rem;
        color: var(--fg);
        word-break: break-all;
    }

    .buttons { display: flex; gap: 0.625rem; }
    button {
        flex: 1;
        padding: 0.6875rem 1rem;
        font-family: inherit;
        font-size: 0.9375rem;
        font-weight: 500;
        border-radius: calc(var(--radius) - 2px);
        border: 1px solid transparent;
        cursor: pointer;
        transition: opacity 0.15s ease, background 0.15s ease;
    }
    .btn-allow { background: var(--primary); color: var(--primary-fg); }
    .btn-allow:hover { opacity: 0.9; }
    .btn-deny {
        background: transparent;
        color: var(--secondary-fg);
        border-color: var(--border);
    }
    .btn-deny:hover { background: var(--muted); }

    .msg {
        text-align: left;
        border: 1px solid var(--border);
        border-radius: calc(var(--radius) - 3px);
        padding: 0.875rem 1rem;
        font-size: 0.9375rem;
        color: var(--fg);
        margin-bottom: 1.25rem;
    }
    .msg.error { border-left: 3px solid var(--destructive); }

    .footnote {
        font-size: 0.8125rem;
        color: var(--muted-fg);
        max-width: 26rem;
        text-align: center;
    }
    .footnote a { color: var(--muted-fg); text-decoration: underline; }
    .footnote a:hover { color: var(--fg); }
""" % {"sans": _SANS, "mono": _MONO}


def _mark_svg() -> str:
    return (
        '<svg viewBox="0 0 24 24" role="img" aria-label="re:call" '
        'fill="currentColor"><path d="%s"/></svg>' % _MARK_PATH
    )


def _brand() -> str:
    return f'<div class="brand">{_mark_svg()}<span class="word">re:call</span></div>'


def _page(body: str, title: str, csp_policy: str | None) -> str:
    """Wrap page body in the re:call-styled HTML shell."""
    title_esc = _html.escape(title)
    csp_meta = ""
    if csp_policy:
        csp_meta = (
            '<meta http-equiv="Content-Security-Policy" '
            f'content="{_html.escape(csp_policy, quote=True)}" />'
        )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title_esc}</title>
    {csp_meta}
    <style>{_TOKENS_CSS}{_BASE_CSS}</style>
</head>
<body>
{body}
</body>
</html>"""


# Friendly labels for common scopes; unknown scopes fall through verbatim.
_SCOPE_LABELS = {
    "access": "Access your re:call workspaces",
    "openid": "Verify your identity",
    "profile": "Read your basic profile",
    "email": "Read your email address",
    "offline_access": "Stay connected in the background",
    "User.Read": "Read your Microsoft profile",
}


def create_consent_html(
    client_id: str,
    redirect_uri: str,
    scopes: list[str],
    txn_id: str,
    csrf_token: str,
    client_name: str | None = None,
    title: str = "Authorize access",
    server_name: str | None = None,
    server_icon_url: str | None = None,
    server_website_url: str | None = None,
    client_website_url: str | None = None,
    csp_policy: str | None = None,
    is_cimd_client: bool = False,
    cimd_domain: str | None = None,
    **_kwargs: object,
) -> str:
    """re:call-branded replacement for FastMCP's consent page.

    Keeps the POST form contract (`txn_id`, `csrf_token`, `submit`, and the
    `action=approve|deny` buttons) the proxy's submit handler reads back.
    """
    client_display = _html.escape(client_name or client_id)

    scope_items = "".join(
        f'<li><span class="dot"></span>{_html.escape(_SCOPE_LABELS.get(s, s))}</li>'
        for s in scopes
    )
    scopes_block = f'<ul class="scopes">{scope_items}</ul>' if scope_items else ""

    cimd_badge = ""
    if is_cimd_client and cimd_domain:
        cimd_badge = (
            '<div class="badge"><span class="check">&#x2713;</span>'
            f"Verified&nbsp;domain: <strong>{_html.escape(cimd_domain)}</strong></div>"
        )

    redirect_esc = _html.escape(redirect_uri)
    callout = (
        '<div class="callout">'
        '<span class="label">Credentials will be sent to</span>'
        f'<span class="value">{redirect_esc}</span></div>'
    )

    detail_rows = [
        ("Application", _html.escape(client_name or client_id)),
        ("Website", _html.escape(client_website_url or "N/A")),
        ("Application ID", _html.escape(client_id)),
        ("Redirect URI", redirect_esc),
        (
            "Requested scopes",
            ", ".join(_html.escape(s) for s in scopes) if scopes else "None",
        ),
    ]
    rows_html = "".join(
        f'<div class="row"><span class="k">{k}</span><span class="v">{v}</span></div>'
        for k, v in detail_rows
    )
    advanced = (
        "<details><summary>Advanced details</summary>"
        f'<div class="rows">{rows_html}</div></details>'
    )

    form = f"""
        <form method="POST" action="">
            <input type="hidden" name="txn_id" value="{_html.escape(txn_id, quote=True)}" />
            <input type="hidden" name="csrf_token" value="{_html.escape(csrf_token, quote=True)}" />
            <input type="hidden" name="submit" value="true" />
            <div class="buttons">
                <button type="submit" name="action" value="approve" class="btn-allow">Allow</button>
                <button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
            </div>
        </form>
    """

    footnote = (
        '<p class="footnote">re:call asks for your consent before connecting a new '
        "client, to protect against "
        '<a href="https://modelcontextprotocol.io/specification/2025-06-18/basic/'
        'security_best_practices#confused-deputy-problem" target="_blank" '
        'rel="noopener noreferrer">confused-deputy attacks</a>.</p>'
    )

    body = f"""
        <div class="card">
            {_brand()}
            <h1>Authorize access</h1>
            <p class="lede"><strong>{client_display}</strong> wants to connect to
            your re:call workspace.</p>
            {cimd_badge}
            {scopes_block}
            {callout}
            {advanced}
            {form}
        </div>
        {footnote}
    """

    # CSP: mirror FastMCP's consent policy. None → build the default (which must
    # allow form submission to the client's redirect scheme, incl. custom schemes
    # like cursor:// or vscode://); "" → no CSP; else use as given.
    if csp_policy is None:
        scheme = urlparse(redirect_uri).scheme.lower()
        form_action = ["https:", "http:"]
        if scheme and scheme not in ("http", "https"):
            form_action.append(f"{scheme}:")
        csp_policy = (
            "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; "
            f"base-uri 'none'; form-action {' '.join(form_action)}"
        )

    return _page(body, title, csp_policy)


def create_error_html(
    error_title: str,
    error_message: str,
    error_details: dict[str, str] | None = None,
    server_name: str | None = None,
    server_icon_url: str | None = None,
    **_kwargs: object,
) -> str:
    """re:call-branded replacement for FastMCP's OAuth error page."""
    message = _html.escape(error_message)

    details_section = ""
    if error_details:
        rows_html = "".join(
            f'<div class="row"><span class="k">{_html.escape(k)}</span>'
            f'<span class="v">{_html.escape(v)}</span></div>'
            for k, v in error_details.items()
        )
        details_section = (
            "<details><summary>Details</summary>"
            f'<div class="rows">{rows_html}</div></details>'
        )

    body = f"""
        <div class="card">
            {_brand()}
            <h1>{_html.escape(error_title)}</h1>
            <div class="msg error">{message}</div>
            {details_section}
        </div>
    """

    csp_policy = (
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; "
        "base-uri 'none'"
    )
    return _page(body, error_title, csp_policy)


def apply_recall_oauth_branding() -> None:
    """Swap re:call's page builders into FastMCP's OAuth proxy modules.

    Idempotent. Patches the names where they are *used* (resolved from each
    module's globals at call time), not just where they are defined. Never
    raises: a FastMCP layout change degrades to the stock pages rather than
    taking down the server.
    """
    try:
        from fastmcp.server.auth.oauth_proxy import consent as _consent
        from fastmcp.server.auth.oauth_proxy import proxy as _proxy

        _consent.create_consent_html = create_consent_html
        _proxy.create_error_html = create_error_html
    except Exception:  # noqa: BLE001 — never block startup on branding
        import logging

        logging.getLogger("recall").warning(
            "could not apply re:call OAuth page branding; using FastMCP defaults",
            exc_info=True,
        )
