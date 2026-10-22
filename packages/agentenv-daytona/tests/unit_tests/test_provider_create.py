"""DaytonaSandboxProvider: create, reconnect, cleanup and preview-domain learning."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from agent_env.providers.sandbox_providers.sandbox import (
    NetworkMode,
    NetworkPolicy,
    NetworkPolicyUnsupportedError,
)
from daytona import (
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    DaytonaBadRequestError,
    DaytonaAuthenticationError,
    DaytonaRateLimitError,
    DaytonaTimeoutError,
)

from agentenv_daytona import provider as provider_module
from agentenv_daytona.config import (
    IMAGE_CREATE_TIMEOUT,
    MANAGED_LABEL,
    PORTS_LABEL,
    SNAPSHOT_CREATE_TIMEOUT,
    parse_settings,
)
from agentenv_daytona.provider import DaytonaSandboxProvider
from agentenv_daytona.sandbox import DaytonaSandbox
from tests.unit_tests.fakes import FakeDaytona, FakeProcess, FakeRaw

TEMPLATE = "https://{{PORT}}-{{sandboxId}}.proxy-x.example"


@pytest.fixture(autouse=True)
def fresh_preview_hosts() -> Iterator[None]:
    provider_module.forget_preview_hosts()
    yield
    provider_module.forget_preview_hosts()


def allow(*hosts: str, cidrs: tuple[str, ...] = ()) -> NetworkPolicy:
    return NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=hosts, allow_cidrs=cidrs)


def make(
    client: FakeDaytona | None = None, **config: object
) -> tuple[DaytonaSandboxProvider, FakeDaytona]:
    fake = client or FakeDaytona()
    provider = DaytonaSandboxProvider(
        parse_settings({"api_key": "k", **config}),
        client_factory=lambda settings: fake,
        fetch_template=lambda api_url: TEMPLATE,
    )
    provider._RATE_LIMIT_BASE_DELAY = 0
    provider._RECLAIM_DELAY = 0
    return provider, fake


async def test_create_vm_builds_the_host_image_at_the_requested_size_as_a_public_ephemeral_sandbox() -> (
    None
):
    provider, fake = make()

    sandbox = await provider.create_vm(
        cpu=4,
        memory=8192,
        disk_size_gb=20,
        timeout=900,
        exposed_ports=[8080, 8080, 5432],
        setup_for_gateway=False,
        attribution={"run_id": "r1"},
    )

    params = fake.created_params[0]
    assert isinstance(params, CreateSandboxFromImageParams)
    assert params.resources is not None and params.labels is not None and params.name is not None
    assert (params.resources.cpu, params.resources.memory, params.resources.disk) == (4, 8, 20)
    assert (params.public, params.ephemeral, params.auto_stop_interval, params.ttl_minutes) == (
        True,
        True,
        0,
        15,
    )
    assert params.labels[MANAGED_LABEL] == "true" and params.labels[PORTS_LABEL] == "8080,5432"
    assert params.labels["agentenv.attr.run_id"] == "r1" and params.name.startswith("ae-")
    assert fake.create_timeouts == [IMAGE_CREATE_TIMEOUT]
    assert (
        isinstance(sandbox, DaytonaSandbox) and sandbox.type == "daytona" and sandbox.mode == "vm"
    )
    assert sandbox.tunnel_urls == {
        8080: f"https://8080-{sandbox.sandbox_id}.proxy-x.example",
        5432: f"https://5432-{sandbox.sandbox_id}.proxy-x.example",
    }
    assert sandbox.network_policy == NetworkPolicy()


async def test_a_configured_snapshot_is_used_instead_of_the_image() -> None:
    provider, fake = make(snapshot="my-dind")

    await provider.create_vm(setup_for_gateway=False)

    params = fake.created_params[0]
    assert isinstance(params, CreateSandboxFromSnapshotParams) and params.snapshot == "my-dind"
    assert fake.create_timeouts == [SNAPSHOT_CREATE_TIMEOUT]


async def test_create_sandbox_is_a_bare_vm_exposing_the_port() -> None:
    provider, fake = make()

    sandbox = await provider.create_sandbox(
        image_name="ignored:1", port=9000, env={"SECRET": "s"}, timeout=600
    )

    assert list(sandbox.tunnel_urls) == [9000]
    assert "SECRET" not in str(fake.created_params[0])


async def test_setup_for_gateway_runs_after_create() -> None:
    provider, fake = make()

    sandbox = await provider.create_vm(exposed_ports=[8080])

    commands = fake.sandboxes[sandbox.sandbox_id].process.commands
    assert ["sudo", "docker", "compose", "version"] in commands


async def test_an_image_override_is_refused() -> None:
    provider, fake = make()

    with pytest.raises(ValueError, match="image overrides"):
        await provider.create_vm(image="ubuntu:24.04")

    assert fake.created_params == []


@pytest.mark.parametrize(
    "policy",
    [allow("1.2.3.4"), allow(cidrs=("10.0.0.0/8",)), allow("pypi.org", cidrs=("10.0.0.0/8",))],
)
async def test_unenforceable_policies_are_refused_before_anything_is_created(
    policy: NetworkPolicy,
) -> None:
    provider, fake = make()

    assert not DaytonaSandboxProvider.supports_network_policy(policy)
    with pytest.raises(NetworkPolicyUnsupportedError):
        await provider.create_vm(network_policy=policy)

    assert fake.created_params == []


async def test_a_restricted_create_allows_the_preview_domain_from_the_api_and_configured_hosts() -> (
    None
):
    provider, fake = make(egress_hosts=["*.internal.example"])

    sandbox = await provider.create_vm(network_policy=allow("pypi.org"), setup_for_gateway=False)

    sent = set((fake.created_params[0].domain_allow_list or "").split(","))
    assert {"pypi.org", "*.proxy-x.example", "*.internal.example"} <= sent
    assert (
        sandbox.network_policy is not None
        and "*.proxy-x.example" in sandbox.network_policy.allow_hosts
    )
    assert "*.proxy-x.example" in DaytonaSandboxProvider.EGRESS_HOSTS


async def test_a_sandbox_served_on_another_proxy_domain_widens_its_own_allowlist() -> None:
    fake = FakeDaytona(make_raw=lambda: FakeRaw(preview_domain="eu.proxy-y.example"))
    provider, _ = make(fake)

    sandbox = await provider.create_vm(
        network_policy=allow("pypi.org"), exposed_ports=[8080], setup_for_gateway=False
    )

    raw = fake.sandboxes[sandbox.sandbox_id]
    assert len(raw.network_updates) == 1
    assert "*.eu.proxy-y.example" in raw.network_updates[0]["domain_allow_list"].split(",")
    assert (
        "*.eu.proxy-y.example"
        in DaytonaSandboxProvider.effective_network_policy(allow("x.example")).allow_hosts
    )


def _unreachable_config(api_url: str) -> str:
    raise OSError(f"{api_url}/config unreachable")


async def test_the_api_lookup_failing_is_not_fatal_and_learning_from_the_sandbox_still_works() -> (
    None
):
    fake = FakeDaytona()
    provider = DaytonaSandboxProvider(
        parse_settings({"api_key": "k"}),
        client_factory=lambda s: fake,
        fetch_template=_unreachable_config,
    )

    sandbox = await provider.create_vm(network_policy=allow("pypi.org"), setup_for_gateway=False)

    assert "*.proxy-x.example" in (sandbox.network_policy or allow()).allow_hosts


async def test_a_failed_setup_deletes_the_sandbox() -> None:
    provider, fake = make()
    fake.make_raw = lambda: FakeRaw(process=_failing_process())

    with pytest.raises(RuntimeError):
        await provider.create_vm(exposed_ports=[8080])

    assert [raw.deletes for raw in fake.sandboxes.values()] == [1]


def _failing_process() -> FakeProcess:
    return FakeProcess(
        handler=lambda argv: (1, "", "compose missing") if "compose" in argv else (0, "", "")
    )


async def test_a_create_cancelled_in_flight_deletes_the_sandbox_once_it_exists() -> None:
    started, release = asyncio.Event(), asyncio.Event()

    async def slow(params: object, raw: FakeRaw) -> None:
        started.set()
        await release.wait()

    provider, fake = make(FakeDaytona(create_hook=slow))
    task = asyncio.ensure_future(provider.create_vm(setup_for_gateway=False))
    await started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    for _ in range(50):
        await asyncio.sleep(0)

    assert [raw.deletes for raw in fake.sandboxes.values()] == [1]


async def test_a_create_that_fails_after_making_a_sandbox_deletes_it_by_name() -> None:
    async def made_then_failed(params: object, raw: FakeRaw) -> None:
        fake.sandboxes[raw.id] = raw
        raise DaytonaTimeoutError("Sandbox failed to become ready within the timeout period")

    provider, fake = make(FakeDaytona(create_hook=made_then_failed))

    with pytest.raises(DaytonaTimeoutError):
        await provider.create_vm(setup_for_gateway=False)

    assert [raw.deletes for raw in fake.sandboxes.values()] == [1]


async def test_rate_limited_creates_are_retried() -> None:
    failures = [DaytonaRateLimitError("slow down"), DaytonaRateLimitError("slow down")]

    def throttle(params: object, raw: FakeRaw) -> None:
        if failures:
            raise failures.pop(0)

    provider, fake = make(FakeDaytona(create_hook=throttle))

    sandbox = await provider.create_vm(setup_for_gateway=False)

    assert len(fake.created_params) == 3 and sandbox.sandbox_id in fake.sandboxes


async def test_rate_limiting_that_never_clears_gives_up() -> None:
    def throttle(params: object, raw: FakeRaw) -> None:
        raise DaytonaRateLimitError("slow down")

    provider, fake = make(FakeDaytona(create_hook=throttle))

    with pytest.raises(DaytonaRateLimitError):
        await provider.create_vm(setup_for_gateway=False)

    assert len(fake.created_params) == provider._RATE_LIMIT_ATTEMPTS


async def test_an_org_that_may_not_restrict_egress_gets_a_policy_error() -> None:
    def refuse(params: object, raw: FakeRaw) -> None:
        raise DaytonaBadRequestError("Organization is not allowed to set domain allow list")

    provider, _ = make(FakeDaytona(create_hook=refuse))

    with pytest.raises(NetworkPolicyUnsupportedError, match="not allowed"):
        await provider.create_vm(network_policy=allow("pypi.org"), setup_for_gateway=False)


async def test_reconnect_restores_ports_urls_and_policy() -> None:
    provider, fake = make()
    created = await provider.create_vm(
        network_policy=allow("pypi.org"), exposed_ports=[8080], setup_for_gateway=False
    )

    other, _ = make(fake)
    again = await other.get_sandbox(created.sandbox_id)

    assert (again.sandbox_id, again.tunnel_urls, again.network_policy) == (
        created.sandbox_id,
        created.tunnel_urls,
        created.network_policy,
    )


async def test_reconnect_to_an_unexpressible_policy_leaves_it_unknown() -> None:
    provider, fake = make()
    created = await provider.create_vm(setup_for_gateway=False)
    raw = fake.sandboxes[created.sandbox_id]
    raw.domain_allow_list, raw.network_block_all = "pypi.org", True

    again = await provider.get_sandbox(created.sandbox_id)

    assert again.network_policy is None


async def test_close_closes_the_client() -> None:
    provider, fake = make()
    await provider.create_vm(setup_for_gateway=False)

    await provider.close()

    assert fake.closed


async def test_a_create_the_api_rejected_outright_looks_nothing_up() -> None:
    def reject(params: object, raw: FakeRaw) -> None:
        raise DaytonaAuthenticationError("Invalid credentials")

    provider, fake = make(FakeDaytona(create_hook=reject))

    with pytest.raises(DaytonaAuthenticationError):
        await provider.create_vm(setup_for_gateway=False)

    assert fake.lookups == []


async def test_a_failed_setup_retries_a_delete_that_fails_once() -> None:
    from daytona import DaytonaError

    provider, fake = make()
    fake.make_raw = lambda: FakeRaw(
        process=_failing_process(), delete_failures=[DaytonaError("502")]
    )

    with pytest.raises(RuntimeError):
        await provider.create_vm(exposed_ports=[8080])

    (raw,) = fake.sandboxes.values()
    assert (raw.deletes, raw.state) == (2, "destroyed")


async def test_a_cancelled_create_retries_a_delete_that_fails_once() -> None:
    from daytona import DaytonaError

    started, release = asyncio.Event(), asyncio.Event()

    async def slow(params: object, raw: FakeRaw) -> None:
        raw.delete_failures.append(DaytonaError("502"))
        started.set()
        await release.wait()

    provider, fake = make(FakeDaytona(create_hook=slow))
    task = asyncio.ensure_future(provider.create_vm(setup_for_gateway=False))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    for _ in range(100):
        await asyncio.sleep(0)

    (raw,) = fake.sandboxes.values()
    assert (raw.deletes, raw.state) == (2, "destroyed")


async def test_reconnect_widens_a_restricted_allowlist_to_a_new_preview_domain() -> None:
    provider, fake = make()
    created = await provider.create_vm(
        network_policy=allow("pypi.org"), exposed_ports=[8080], setup_for_gateway=False
    )
    raw = fake.sandboxes[created.sandbox_id]
    raw.preview_domain = "moved.proxy-z.example"

    again = await provider.get_sandbox(created.sandbox_id)

    assert again.network_policy is not None
    assert "*.moved.proxy-z.example" in again.network_policy.allow_hosts
    assert "*.moved.proxy-z.example" in (raw.domain_allow_list or "").split(",")
