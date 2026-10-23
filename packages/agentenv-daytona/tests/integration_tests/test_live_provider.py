"""Live smoke test of the daytona provider against real Daytona sandboxes."""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from agent_env.providers.sandbox_providers.sandbox import NetworkMode, NetworkPolicy
from agent_env.providers.sandbox_providers.sandbox_provider import build_sandbox_provider
from daytona import DaytonaNotFoundError

from agentenv_daytona import DaytonaSandbox
from agentenv_daytona.network import policy_from_sandbox
from tests.integration_tests.conftest import LIVE, SESSION, SESSION_LABEL

PORT = 8080
pytestmark = [LIVE, pytest.mark.asyncio(loop_scope="module")]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def vm(live_config: Path) -> AsyncIterator[DaytonaSandbox]:
    sandbox = await build_sandbox_provider("daytona").create_vm(exposed_ports=[PORT], timeout=1800)
    assert isinstance(sandbox, DaytonaSandbox)
    try:
        yield sandbox
    finally:
        await sandbox.terminate()


async def test_vm_runs_docker_serves_a_public_port_takes_uploads_and_reconnects(
    vm: DaytonaSandbox,
) -> None:
    assert (vm.type, vm.mode, vm.network_policy) == ("daytona", "vm", NetworkPolicy())
    assert (await vm.read_raw()).labels[SESSION_LABEL] == SESSION
    code, version, err = await vm.exec_with_output(
        "sudo", "docker", "info", "--format", "{{.ServerVersion}}"
    )
    assert code == 0 and version.strip(), err
    assert (await vm.exec_with_output("sudo", "docker", "compose", "version"))[0] == 0

    await vm.exec_script(
        f"docker run -d --name smoke -p {PORT}:{PORT} public.ecr.aws/docker/library/python:3.12-slim "
        f"python -m http.server {PORT}"
    )
    url = vm.tunnel_urls[PORT]
    assert url.startswith("https://")
    async with httpx.AsyncClient(timeout=10) as client:
        for _ in range(30):
            try:
                if (await client.get(url)).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(2)
        else:
            pytest.fail(f"{url} never answered 200 without credentials")

    payload = os.urandom(9 * 1024 * 1024 + 17)
    await vm.write_host_file(payload, "/opt/smoke/payload.bin")
    digest = await vm.exec_script("sha256sum /opt/smoke/payload.bin")
    assert digest.split()[0] == hashlib.sha256(payload).hexdigest()

    again = await build_sandbox_provider("daytona").get_sandbox(vm.sandbox_id)
    assert (again.sandbox_id, again.tunnel_urls, again.network_policy) == (
        vm.sandbox_id,
        vm.tunnel_urls,
        vm.network_policy,
    )


async def test_terminate_twice_is_fine_and_the_sandbox_is_gone(live_config: Path) -> None:
    provider = build_sandbox_provider("daytona")
    sandbox = await provider.create_vm(timeout=600, setup_for_gateway=False)

    await sandbox.terminate()
    await sandbox.terminate()

    for _ in range(30):
        try:
            await provider.get_sandbox(sandbox.sandbox_id)
        except DaytonaNotFoundError:
            return
        await asyncio.sleep(2)
    pytest.fail(f"{sandbox.sandbox_id} still reachable after terminate")


@pytest.mark.skipif(
    os.environ.get("DAYTONA_TEST_EGRESS") != "1",
    reason="set DAYTONA_TEST_EGRESS=1 (org must allow egress lists)",
)
async def test_an_allowlist_is_enforced_and_survives_reconnect(live_config: Path) -> None:
    policy = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))
    provider = build_sandbox_provider("daytona")
    sandbox = await provider.create_vm(timeout=600, setup_for_gateway=False, network_policy=policy)
    assert isinstance(sandbox, DaytonaSandbox)
    try:
        assert sandbox.network_policy is not None
        assert {"pypi.org"} <= set(sandbox.network_policy.allow_hosts)
        curl = "curl -s -o /dev/null -w '%{http_code}' --max-time 8 "

        async def status(url: str) -> str:
            return (await sandbox.exec_with_output("sh", "-c", curl + url))[1].strip()

        # Enforcement can take a few seconds to settle after create.
        allowed = "000"
        for _ in range(15):
            if (allowed := await status("https://pypi.org/")) != "000":
                break
            await asyncio.sleep(2)
        assert allowed != "000"
        assert await status("https://example.com") == "000"

        # A signed download URL's host is let through before AgentEnv downloads from it.
        await sandbox._allow_download_hosts(["https://example.com/image.tar.gz?signature=x"])
        assert await status("https://example.com") != "000"
        assert sandbox.network_policy is not None
        assert {"example.com"} <= set(sandbox.network_policy.allow_hosts)

        again = await build_sandbox_provider("daytona").get_sandbox(sandbox.sandbox_id)
        assert again.network_policy == sandbox.network_policy
    finally:
        await sandbox.terminate()


@pytest.mark.skipif(
    os.environ.get("DAYTONA_TEST_EGRESS") != "1",
    reason="set DAYTONA_TEST_EGRESS=1 (org must allow egress lists)",
)
async def test_back_to_back_allowlist_updates_both_apply(live_config: Path) -> None:
    policy = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))
    sandbox = await build_sandbox_provider("daytona").create_vm(
        timeout=600, setup_for_gateway=False, network_policy=policy
    )
    assert isinstance(sandbox, DaytonaSandbox) and sandbox.network_policy is not None
    try:
        first = sandbox.network_policy.with_hosts(["a.example.com"])
        second = first.with_hosts(["b.example.com"])

        # Daytona refuses an update while the previous one is still being applied (409).
        await sandbox.apply_network_policy(first)
        await sandbox.apply_network_policy(second)

        applied = policy_from_sandbox(await sandbox.read_raw())
        assert applied is not None
        assert {"a.example.com", "b.example.com"} <= set(applied.allow_hosts)
    finally:
        await sandbox.terminate()
