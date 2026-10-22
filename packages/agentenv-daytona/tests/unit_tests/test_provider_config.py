"""Provider settings, sandbox sizing, names and labels."""

from __future__ import annotations

import pytest
from agent_env.config.errors import ConfigError

from agentenv_daytona.config import (
    DEFAULT_API_URL,
    LABEL_VALUE_MAX,
    MANAGED_LABEL,
    PORTS_LABEL,
    parse_settings,
    sandbox_labels,
    sandbox_name,
    sandbox_resources,
    ttl_minutes,
)
from agentenv_daytona.image import DEFAULT_BASE_IMAGE, HOST_IMAGE_VERSION


def test_only_an_api_key_is_required() -> None:
    settings = parse_settings({"api_key": "k"})

    assert (settings.api_url, settings.target, settings.snapshot, settings.base_image) == (
        DEFAULT_API_URL,
        None,
        None,
        DEFAULT_BASE_IMAGE,
    )
    assert settings.egress_hosts == ()


def test_every_key_is_read() -> None:
    settings = parse_settings(
        {
            "api_key": "k",
            "api_url": "https://d.example/api",
            "target": "eu",
            "snapshot": "my-dind",
            "egress_hosts": ["*.internal.example"],
        }
    )

    assert (settings.api_url, settings.target, settings.snapshot, settings.egress_hosts) == (
        "https://d.example/api",
        "eu",
        "my-dind",
        ("*.internal.example",),
    )


@pytest.mark.parametrize(
    ("config", "message"),
    [
        ({}, "requires a non-empty 'api_key'"),
        ({"api_key": "  "}, "requires a non-empty 'api_key'"),
        ({"api_key": "k", "foo": 1}, "unknown key(s): ['foo']"),
        ({"api_key": "k", "target": 3}, "'target' must be a non-empty string"),
        (
            {"api_key": "k", "snapshot": "s", "base_image": "ubuntu:24.04"},
            "either 'snapshot' or 'base_image'",
        ),
        ({"api_key": "k", "egress_hosts": "a.example"}, "'egress_hosts' must be a list"),
        ({"api_key": "k", "egress_hosts": ["*"]}, "'egress_hosts' must be a list"),
    ],
)
def test_bad_settings_name_the_section_and_the_problem(config: dict, message: str) -> None:
    with pytest.raises(ConfigError) as raised:
        parse_settings(config)

    assert "[sandbox.providers.daytona.config]" in str(raised.value) and message in str(
        raised.value
    )


def test_settings_repr_hides_the_api_key() -> None:
    assert "secret-key" not in repr(parse_settings({"api_key": "secret-key"}))


def test_resources_meet_the_docker_floor_and_round_up() -> None:
    small = sandbox_resources(cpu=1.0, memory_mb=1024, disk_gb=3)
    large = sandbox_resources(cpu=2.5, memory_mb=8193, disk_gb=20.2)

    assert (small.cpu, small.memory, small.disk) == (2, 4, 10)
    assert (large.cpu, large.memory, large.disk) == (3, 9, 21)


@pytest.mark.parametrize(("timeout", "minutes"), [(1, 1), (60, 1), (61, 2), (7200, 120)])
def test_timeout_seconds_become_whole_ttl_minutes(timeout: int, minutes: int) -> None:
    assert ttl_minutes(timeout) == minutes


def test_labels_carry_attribution_ports_and_the_managed_marker() -> None:
    labels = sandbox_labels({"run_id": "run 42/x", "team": "env-pod", "skip": None}, [8080, 5432])

    assert labels[MANAGED_LABEL] == "true"
    assert labels[PORTS_LABEL] == "8080,5432"
    assert labels["agentenv.host-image"] == HOST_IMAGE_VERSION
    assert labels["agentenv.attr.run_id"] == "run-42-x"
    assert labels["agentenv.attr.team"] == "env-pod"
    assert "agentenv.attr.skip" not in labels


def test_label_values_are_bounded() -> None:
    labels = sandbox_labels({"long": "v" * 1000}, [])

    assert len(labels["agentenv.attr.long"]) == LABEL_VALUE_MAX


def test_names_are_unique_prefixed_and_short() -> None:
    first = sandbox_name({"run_id": "r1", "pipeline_step": "task_box" * 20})
    second = sandbox_name({"run_id": "r1"})

    assert first.startswith("ae-") and second.startswith("ae-") and first != second
    assert len(first) <= 63 and first[-1] != "-"
