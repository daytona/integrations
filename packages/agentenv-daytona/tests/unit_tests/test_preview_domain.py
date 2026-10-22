"""Learning the preview proxy domain from what Daytona returns, never from a constant."""

from pathlib import Path

import pytest

from agentenv_daytona.preview_domain import pattern_from_template, preview_host_pattern


@pytest.mark.parametrize(
    ("url", "pattern"),
    [
        (
            "https://8080-0078c3e5-5c00-4503-adbc-bf52328e5305.daytonaproxy01.net",
            "*.daytonaproxy01.net",
        ),
        ("https://3000-sb-1.proxy-x.example/path?q=1", "*.proxy-x.example"),
        ("https://5432-abc.eu.preview.acme.dev", "*.eu.preview.acme.dev"),
    ],
)
def test_preview_url_gives_a_wildcard_for_its_proxy_domain(url: str, pattern: str) -> None:
    assert preview_host_pattern(url) == pattern


@pytest.mark.parametrize(
    "url",
    [
        "https://daytonaproxy01.net",
        "https://abc-8080.proxy.example",
        "https://8080-id.localhost",
        "not a url",
    ],
)
def test_unrecognized_preview_urls_are_refused_not_guessed(url: str) -> None:
    with pytest.raises(ValueError):
        preview_host_pattern(url)


def test_proxy_template_from_the_config_endpoint_gives_the_same_wildcard() -> None:
    assert (
        pattern_from_template("https://{{PORT}}-{{sandboxId}}.daytonaproxy01.net")
        == "*.daytonaproxy01.net"
    )


def test_unrecognized_template_is_refused() -> None:
    with pytest.raises(ValueError):
        pattern_from_template("https://proxy.example/{{PORT}}/{{sandboxId}}")


def test_no_proxy_domain_is_hardcoded_in_the_package() -> None:
    package = Path(__file__).resolve().parents[2] / "agentenv_daytona"

    offenders = [p.name for p in package.rglob("*.py") if "daytonaproxy" in p.read_text()]

    assert offenders == []
