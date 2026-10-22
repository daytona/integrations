"""AgentEnv NetworkPolicy <-> Daytona egress fields."""

from types import SimpleNamespace

import pytest
from agent_env.providers.sandbox_providers.sandbox import NetworkMode, NetworkPolicy

from agentenv_daytona.network import (
    MAX_CIDR_ENTRIES,
    MAX_DOMAIN_ENTRIES,
    create_fields,
    policy_from_sandbox,
    policy_problem,
    update_fields,
)


def allow(*hosts: str, cidrs: tuple[str, ...] = ()) -> NetworkPolicy:
    return NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=hosts, allow_cidrs=cidrs)


def raw(
    domains: str | None = None, cidrs: str | None = None, block_all: bool = False
) -> SimpleNamespace:
    return SimpleNamespace(
        domain_allow_list=domains, network_allow_list=cidrs, network_block_all=block_all
    )


@pytest.mark.parametrize(
    "policy",
    [
        NetworkPolicy(),
        allow(),
        allow("pypi.org", "*.github.com"),
        allow(cidrs=("10.0.0.0/8", "1.1.1.1/32")),
    ],
)
def test_enforceable_policies_have_no_problem(policy: NetworkPolicy) -> None:
    assert policy_problem(policy) is None


@pytest.mark.parametrize(
    ("policy", "reason"),
    [
        (allow("pypi.org", cidrs=("10.0.0.0/8",)), "mutually exclusive"),
        (allow("1.2.3.4"), "IP address"),
        (allow(cidrs=("2001:db8::/32",)), "IPv6"),
        (
            allow(*(f"h{i}.example.com" for i in range(MAX_DOMAIN_ENTRIES + 1))),
            str(MAX_DOMAIN_ENTRIES),
        ),
        (
            allow(cidrs=tuple(f"10.0.{i}.0/24" for i in range(MAX_CIDR_ENTRIES + 1))),
            str(MAX_CIDR_ENTRIES),
        ),
    ],
)
def test_unenforceable_policies_name_why(policy: NetworkPolicy, reason: str) -> None:
    problem = policy_problem(policy)

    assert problem is not None and reason in problem


def test_create_fields_allow_all_sends_nothing() -> None:
    assert create_fields(NetworkPolicy()) == {}


def test_create_fields_empty_allowlist_blocks_everything() -> None:
    assert create_fields(allow()) == {"network_block_all": True}


def test_create_fields_hosts_go_to_the_domain_list_and_cidrs_to_the_network_list() -> None:
    assert create_fields(allow("pypi.org", "*.github.com")) == {
        "domain_allow_list": "pypi.org,*.github.com"
    }
    assert create_fields(allow(cidrs=("10.0.0.0/8",))) == {"network_allow_list": "10.0.0.0/8"}


def test_update_fields_name_only_the_list_in_use_so_stale_entries_are_replaced() -> None:
    assert update_fields(NetworkPolicy()) == {
        "network_block_all": False,
        "domain_allow_list": "",
        "network_allow_list": "",
    }
    assert update_fields(allow()) == {"network_block_all": True}
    assert update_fields(allow("a.example.com")) == {
        "network_block_all": False,
        "domain_allow_list": "a.example.com",
    }
    assert update_fields(allow(cidrs=("1.1.1.1/32",))) == {
        "network_block_all": False,
        "network_allow_list": "1.1.1.1/32",
    }


@pytest.mark.parametrize(
    "policy",
    [
        NetworkPolicy(),
        allow(),
        allow("pypi.org", "*.github.com"),
        allow(cidrs=("10.0.0.0/8", "1.1.1.1/32")),
    ],
)
def test_applied_fields_read_back_as_the_same_policy(policy: NetworkPolicy) -> None:
    fields = create_fields(policy)

    applied = raw(
        fields.get("domain_allow_list"),
        fields.get("network_allow_list"),
        bool(fields.get("network_block_all")),
    )

    assert policy_from_sandbox(applied) == policy


def test_read_back_tolerates_spaces_and_empty_entries() -> None:
    assert policy_from_sandbox(raw(" pypi.org , ,*.github.com ")) == allow(
        "pypi.org", "*.github.com"
    )


def test_read_back_of_a_state_agentenv_cannot_express_is_unknown() -> None:
    assert policy_from_sandbox(raw("pypi.org", block_all=True)) is None
    assert policy_from_sandbox(raw("pypi.org", "10.0.0.0/8")) is None
