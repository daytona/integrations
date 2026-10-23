"""The browser driver's pure vocabulary: the address `navigate` opens, the phrase a failed
navigation reports, the ranking `find` returns, and how a CDP value reads as text.

All of it is text in, text out — no browser, no sandbox, no driver state — so it is separate from
`browser.py`, where everything else shares the live tab map and CDP sessions, and it is
unit-tested on its own.
"""

from __future__ import annotations

import json
import re
from typing import Any

from anthropic.tools import ToolError

MAX_TEXT = 2000
"""Characters kept of one piece of page-supplied text — a console line, a script's error, a
dialog's message. A page can make any of them arbitrarily long."""

SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
"""C0 controls and DEL. Only tab, LF and CR are dropped by a URL parser; the rest survive into
the address Chromium opens, re-spelled."""
OPAQUE_SCHEMES = frozenset(
    {
        "about", "blob", "chrome", "chrome-extension", "chrome-untrusted", "data", "devtools",
        "file", "filesystem", "intent", "javascript", "mailto", "sms", "tel", "view-source",
    }
)  # fmt: skip
"""Schemes written without `//`. With any other `x:` prefix (`localhost:3000`) the address is a
host and port with no scheme, and opens as https."""


def normalize_url(url: str) -> str:
    """The address `navigate` opens: `https://` added to a bare host, and every scheme other than
    http and https (and the empty tab, `about:blank`) refused. The SDK checks no scheme itself."""
    # Browsers drop tabs and newlines anywhere in an address and trim C0 controls and spaces.
    text = re.sub(r"[\t\n\r]", "", url)
    text = re.sub(r"^[\x00-\x20]+|[\x00-\x20]+$", "", text)
    if not text:
        raise ToolError("navigate needs a URL, or back, forward or reload.")
    if CONTROL.search(text):
        # A control left in the middle is not dropped: a URL parser percent-encodes it in a path
        # or query and rejects it in a host, so the address a URL policy would be shown is not
        # the one Chromium would open. No real address carries one; refuse rather than guess.
        raise ToolError("navigate does not open a URL containing control characters.")
    if text.lower() == "about:blank":
        return "about:blank"
    match = SCHEME.match(text)
    if match and (text[match.end() :].startswith("//") or match.group(1).lower() in OPAQUE_SCHEMES):
        scheme = match.group(1).lower()
    else:
        text, scheme = f"https://{text}", "https"
    if scheme not in ("http", "https"):
        raise ToolError(f"navigate does not open {scheme}: URLs; use an http or https address.")
    return text


def failure_phrase(exc: Exception) -> str:
    """A fixed phrase for a failed navigation: the net:: error code, never the URL or call log."""
    # Digits belong to the code: without them `net::ERR_HTTP2_PROTOCOL_ERROR` would be reported
    # as `net::ERR_HTTP`, which is not a code Chromium has.
    code = re.search(r"net::ERR_[A-Z0-9_]+", str(exc))
    if code and code.group() == "net::ERR_BLOCKED_BY_CLIENT":
        return "The navigation was refused."
    return f"The navigation failed ({code.group()})." if code else "The navigation failed."


def format_remote(remote: dict[str, Any]) -> str:
    """A CDP RemoteObject (returned by value) as the text the model reads."""
    if remote.get("type") == "undefined":
        return "undefined"
    if "unserializableValue" in remote:
        return str(remote["unserializableValue"])
    if "value" in remote:
        value = remote["value"]
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return str(remote.get("description", ""))


STOPWORDS = frozenset(
    "a an the to for of on in at with and or that this is it its me my please find element "
    "elements".split()
)
ROLE_WORDS = {
    "button": {"button"},
    "btn": {"button"},
    "link": {"link"},
    "input": {"textbox", "searchbox", "combobox"},
    "field": {"textbox", "searchbox", "combobox"},
    "box": {"textbox", "searchbox", "checkbox"},
    "textbox": {"textbox", "searchbox"},
    "search": {"searchbox", "textbox", "combobox"},
    "checkbox": {"checkbox"},
    "radio": {"radio"},
    "dropdown": {"combobox", "listbox"},
    "select": {"combobox", "listbox"},
    "menu": {"combobox", "menuitem"},
    "image": {"img"},
    "picture": {"img"},
    "icon": {"img"},
    "heading": {"heading"},
    "title": {"heading"},
    "tab": {"tab"},
}


def rank(query: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The candidates that share words with the query, best first: a word in the element's name
    counts most, then its role, then its attributes; visible and interactive elements win ties."""
    words = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if w not in STOPWORDS]
    phrase = " ".join(words)
    scored = []
    for candidate in candidates:
        name = str(candidate.get("name") or "").lower()
        attrs = str(candidate.get("attrs") or "").lower()
        role = str(candidate.get("role") or "")
        if role == "text":
            continue
        score = 0.0
        for word in words:
            pattern = re.escape(word)
            roles = ROLE_WORDS.get(word)
            if roles is not None:
                # a role word says what kind of element is wanted more than what it says
                if role in roles:
                    score += 3
                elif re.search(rf"\b{pattern}", name) or re.search(rf"\b{pattern}", attrs):
                    score += 1
            elif re.search(rf"\b{pattern}\b", name):
                score += 3
            elif re.search(rf"\b{pattern}", name):
                score += 2
            elif re.search(rf"\b{pattern}", attrs):
                score += 1
        if phrase and phrase in name:
            score += 5
        if score > 0:
            score += 0.5 * bool(candidate.get("interactive")) + 0.25 * bool(
                candidate.get("visible")
            )
            scored.append((score, candidate))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [candidate for _, candidate in scored]
