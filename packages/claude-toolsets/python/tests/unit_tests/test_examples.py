"""The parts of `examples/` that make a judgement: the example URL policy, and the live scripts'
own checks. They ship as the thing people copy, and a check that cannot fail proves nothing.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import pytest
from anthropic.tools import ToolError
from anthropic.tools.browser import BetaURLContext
from daytona import DaytonaError, DaytonaNotFoundError

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"
CONTEXT = BetaURLContext(member="navigate")


def load(name: str) -> ModuleType:
    """One example script as a module, without running its `main()`."""
    spec = importlib.util.spec_from_file_location(f"_example_{name}", EXAMPLES / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- run_browser.example_policy --------------------------------------------------------------


def test_the_example_policy_allows_its_hosts_and_their_subdomains() -> None:
    policy = load("run_browser").example_policy([" Example.COM ", "iana.org"])
    for url in ("https://example.com/a", "http://www.example.com", "https://iana.org"):
        policy(CONTEXT, url)
    policy(CONTEXT, "about:blank")
    for url in ("https://notexample.com", "https://example.com.evil.test", "ftp://example.com"):
        with pytest.raises(ToolError):
            policy(CONTEXT, url)


@pytest.mark.parametrize("entries", [["."], ["", " ", "."], ["example.com", "."], ["..."]])
def test_an_entry_that_normalizes_to_nothing_cannot_disable_the_allowlist(
    entries: list[str],
) -> None:
    """`.` survives the emptiness test and then normalizes to an empty host, which every name
    ending in a dot — the way any fully qualified name may be written — matches."""
    policy = load("run_browser").example_policy(entries)
    for url in ("https://evil.test", "https://evil.test.", "https://a.b.evil.test."):
        with pytest.raises(ToolError, match="not an allowed host"):
            policy(CONTEXT, url)


# --- exercise_computer._exists ---------------------------------------------------------------


def test_only_a_not_found_answer_counts_the_sandbox_as_gone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deletion check reads "gone" as success. A transient API or credential failure must
    not be able to spell it."""
    module = load("exercise_computer")
    client = MagicMock()
    monkeypatch.setattr(module, "Daytona", lambda *args, **kwargs: client)

    client.get.return_value = object()
    assert module._exists("sbx-1") is True

    client.get.side_effect = DaytonaNotFoundError("sandbox not found", status_code=404)
    assert module._exists("sbx-1") is False

    for error in (
        DaytonaError("unauthorized", status_code=401),
        DaytonaError("service unavailable", status_code=503),
        RuntimeError("the network went away"),
    ):
        client.get.side_effect = error
        with pytest.raises(type(error)):
            module._exists("sbx-1")
