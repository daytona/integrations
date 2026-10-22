"""The provider as AgentEnv finds it: through the entry point, the plugin inventory and config."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from agent_env.config import reset_config
from agent_env.config.errors import ConfigError
from agent_env.plugins import SANDBOX_PROVIDERS, inventory
from agent_env.providers.sandbox_providers.chained_sandbox_provider import ChainedSandboxProvider
from agent_env.providers.sandbox_providers.sandbox_provider import (
    build_sandbox_provider,
    reset_sandbox_provider,
)

from agentenv_daytona import DaytonaSandbox, DaytonaSandboxProvider

TABLE = '[sandbox.providers.daytona.config]\napi_key = "env:DAYTONA_TEST_FAKE_KEY"\n'


@pytest.fixture
def config_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    path = tmp_path / "config.toml"
    path.write_text(TABLE)
    monkeypatch.setenv("AGENT_ENV_CONFIG", str(path))
    monkeypatch.setenv("DAYTONA_TEST_FAKE_KEY", "dummy-key")
    reset_config()
    reset_sandbox_provider()
    yield path
    reset_config()
    reset_sandbox_provider()


def test_the_daytona_name_builds_this_provider_from_config(config_file: Path) -> None:
    provider = build_sandbox_provider("daytona")

    assert isinstance(provider, DaytonaSandboxProvider)
    assert "dummy-key" not in repr(provider)


def test_the_plugin_inventory_lists_the_daytona_provider_as_active(config_file: Path) -> None:
    contributions = [
        contribution
        for distribution in inventory().distributions
        if distribution.name == "agentenv-daytona"
        for contribution in distribution.contributions
    ]

    assert [(c.group, c.name, c.status) for c in contributions] == [
        (SANDBOX_PROVIDERS, "daytona", "active")
    ]


def test_the_provider_creates_vms_whose_type_matches_its_registry_name(config_file: Path) -> None:
    assert DaytonaSandboxProvider.SUPPORTED_SANDBOX_MODES == {"vm", "container"}
    assert DaytonaSandbox.type == "daytona"


def test_an_unknown_config_key_fails_the_build(config_file: Path) -> None:
    config_file.write_text(TABLE + 'surprise = "x"\n')
    reset_config()

    with pytest.raises(ConfigError, match="unknown key"):
        build_sandbox_provider("daytona")


def test_daytona_works_in_a_fallback_chain_with_the_local_provider(config_file: Path) -> None:
    chain = build_sandbox_provider("daytona,local")

    assert isinstance(chain, ChainedSandboxProvider)
    assert isinstance(chain.links[0], DaytonaSandboxProvider)
