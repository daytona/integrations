"""The domain Daytona serves preview URLs on, learned from Daytona rather than written down.

A preview URL is ``https://<port>-<sandbox-id>.<proxy domain>``; the proxy domain differs between
Daytona deployments and can change, so it is read from the URLs Daytona hands out, or before any
sandbox exists from the API's ``/config`` ``proxyTemplateUrl``, and turned into a ``*.<domain>``
allowlist entry that lets restricted sandboxes reach each other's ports.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.request
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_PORT_AND_ID = re.compile(r"^\d+-[A-Za-z0-9][A-Za-z0-9-]*$")
# Preview domains seen by this process, added to every restricted sandbox's allowlist. They count toward
# Daytona's 100-hostname limit, so only a handful are kept; one or two is the norm.
_learned: set[str] = set()
_MAX_LEARNED = 16


def learn(pattern: str) -> bool:
    """Remember ``pattern``; whether it was new. Past the cap a new domain is skipped, with a warning."""
    if pattern in _learned:
        return False
    if len(_learned) >= _MAX_LEARNED:
        logger.warning(
            "Not allowing Daytona preview domain %s: %s are already allowed", pattern, _MAX_LEARNED
        )
        return False
    _learned.add(pattern)
    return True


def learned() -> list[str]:
    return sorted(_learned)


def forget() -> None:
    _learned.clear()


def preview_host_pattern(url: str) -> str:
    """``*.<proxy domain>`` for a Daytona preview ``url``; ValueError for any other shape."""
    host = urlparse(url).hostname or ""
    first, _, rest = host.partition(".")
    if not _PORT_AND_ID.match(first) or "." not in rest:
        raise ValueError(
            f"not a Daytona preview URL of the form https://<port>-<sandbox-id>.<domain>: {url!r}"
        )
    return f"*.{rest}"


def pattern_from_template(template: str) -> str:
    """``*.<proxy domain>`` for the API's ``proxyTemplateUrl`` (``https://{{PORT}}-{{sandboxId}}.<domain>``)."""
    return preview_host_pattern(template.replace("{{PORT}}", "1").replace("{{sandboxId}}", "x"))


def fetch_proxy_template(api_url: str, *, timeout: float = 10) -> str:
    """The deployment's ``proxyTemplateUrl`` from ``GET <api_url>/config``. Blocking; the endpoint is
    public, so no credentials are sent."""
    with urllib.request.urlopen(
        f"{api_url.rstrip('/')}/config", timeout=timeout
    ) as response:  # noqa: S310
        template = json.load(response).get("proxyTemplateUrl")
    if not isinstance(template, str) or not template:
        raise ValueError(f"{api_url}/config has no proxyTemplateUrl")
    return template
