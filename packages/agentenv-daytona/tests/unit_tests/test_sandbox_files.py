"""DaytonaSandbox uploads (file API + root join) and egress widening for downloads."""

from __future__ import annotations

import asyncio
import hashlib
import re
from typing import Any

import pytest
from agent_env.providers.sandbox_providers.sandbox import NetworkMode, NetworkPolicy
from daytona import DaytonaBadRequestError, DaytonaConflictError

from agentenv_daytona.network import create_fields
from agentenv_daytona.sandbox import DaytonaSandbox
from tests.unit_tests.fakes import FakeFs, FakeRaw, Handler, Outcome

MIB = 1024 * 1024


def joining_handler(raw: FakeRaw, *, corrupt: bool = False) -> Handler:
    """Answers the join script with the sha256 of the uploaded parts it names, in order."""

    def handle(argv: list[str]) -> Outcome:
        script = argv[-1]
        stem_match = re.search(r'cat "(\S+)\.\$i"', script)
        count_match = re.search(r"seq 0 (\d+)", script)
        if stem_match and count_match and "sha256sum" in script:
            stem = stem_match.group(1)
            count = int(count_match.group(1)) + 1
            data = b"".join(raw.fs.files[f"{stem}.{i}"] for i in range(count))
            digest = hashlib.sha256(data + (b"x" if corrupt else b"")).hexdigest()
            return (0, f"{digest}  /target\n", "")
        return (0, "", "")

    return handle


def make(
    policy: NetworkPolicy | None = NetworkPolicy(), **raw_kwargs: Any
) -> tuple[DaytonaSandbox, FakeRaw]:
    raw = FakeRaw(**raw_kwargs)
    if policy is not None:
        fields = create_fields(policy)
        raw.domain_allow_list = fields.get("domain_allow_list")
        raw.network_block_all = bool(fields.get("network_block_all"))

    async def read_raw() -> FakeRaw:
        return raw

    return DaytonaSandbox(raw, tunnel_urls={}, network_policy=policy, read_raw=read_raw), raw


async def test_a_large_write_goes_up_in_parts_and_is_joined_as_root_with_a_checksum() -> None:
    sandbox, raw = make()
    raw.process.handler = joining_handler(raw)
    payload = bytes(range(256)) * (9 * MIB // 256) + b"tail-17-bytes!!!!"

    await sandbox.write_host_file(payload, "/opt/smoke/payload.bin")

    parts = [path for path in raw.fs.files if path.startswith("/tmp/_ae_upload_")]
    assert len(parts) == 3
    join = next(cmd for cmd in raw.process.commands if "sha256sum" in cmd[-1])
    assert join[:3] == ["sudo", "bash", "-c"] and "> /opt/smoke/payload.bin" in join[-1]
    assert any("rm -f" in cmd[-1] for cmd in raw.process.commands)


async def test_a_checksum_mismatch_fails_the_write() -> None:
    sandbox, raw = make()
    raw.process.handler = joining_handler(raw, corrupt=True)

    with pytest.raises(RuntimeError, match="does not match the upload"):
        await sandbox.write_host_file(b"hello", "/opt/x")


async def test_a_failed_part_upload_propagates_and_still_cleans_up_parts() -> None:
    sandbox, raw = make(
        fs=FakeFs(fail_on=lambda path: OSError("upload refused") if path.endswith(".1") else None)
    )
    raw.process.handler = joining_handler(raw)

    with pytest.raises(OSError, match="upload refused"):
        await sandbox.write_host_file(b"a" * (5 * MIB), "/opt/x")

    assert any("rm -f" in cmd[-1] for cmd in raw.process.commands)
    assert not any("sha256sum" in cmd[-1] for cmd in raw.process.commands)


async def test_download_hosts_widen_an_allowlist_once_and_wait_for_them() -> None:
    policy = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))
    sandbox, raw = make(policy)

    await sandbox._allow_download_hosts(
        ["https://bucket.s3.amazonaws.com/a?sig=1", "https://pypi.org/x"]
    )

    assert raw.network_updates == [
        {"network_block_all": False, "domain_allow_list": "pypi.org,bucket.s3.amazonaws.com"}
    ]
    assert (
        sandbox.network_policy is not None
        and "bucket.s3.amazonaws.com" in sandbox.network_policy.allow_hosts
    )
    assert any(
        cmd[:2] == ["sh", "-c"] and "https://bucket.s3.amazonaws.com/" in cmd[2]
        for cmd in raw.process.commands
    )


async def test_concurrent_widenings_keep_every_host() -> None:
    policy = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))
    sandbox, raw = make(policy)

    await asyncio.gather(
        sandbox._allow_download_hosts(["https://a.example.com/x"]),
        sandbox._allow_download_hosts(["https://b.example.com/y"]),
    )

    assert set((raw.domain_allow_list or "").split(",")) == {
        "pypi.org",
        "a.example.com",
        "b.example.com",
    }


async def test_hosts_already_allowed_cause_no_update() -> None:
    policy = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))
    sandbox, raw = make(policy)

    await sandbox._allow_download_hosts(["https://pypi.org/simple"])

    assert raw.network_updates == []


async def test_an_unknown_applied_policy_refuses_to_widen() -> None:
    policy = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))
    sandbox, raw = make(policy)
    raw.network_block_all = True  # block_all with a list: not a policy agent-env applies

    with pytest.raises(RuntimeError, match="cannot be widened"):
        await sandbox._allow_download_hosts(["https://a.example.com/x"])

    assert raw.network_updates == []


async def test_loading_images_into_a_sandbox_with_unknown_policy_fails_closed_before_downloading() -> (
    None
):
    sandbox, raw = make(policy=None)

    with pytest.raises(RuntimeError, match="network policy is unknown"):
        await sandbox._load_tarballs([object()])

    assert raw.process.commands == []


async def test_apply_network_policy_replaces_the_applied_lists() -> None:
    sandbox, raw = make(NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",)))

    await sandbox.apply_network_policy(NetworkPolicy())

    assert raw.network_updates == [
        {"network_block_all": False, "domain_allow_list": "", "network_allow_list": ""}
    ]
    assert sandbox.network_policy == NetworkPolicy()


CONFLICT = "An operation is already in progress for this resource"
PYPI_ONLY = NetworkPolicy(mode=NetworkMode.ALLOWLIST, allow_hosts=("pypi.org",))


def fast_retries(sandbox: DaytonaSandbox) -> DaytonaSandbox:
    sandbox._NETWORK_UPDATE_RETRY_DELAY = 0
    return sandbox


async def test_an_update_refused_while_the_previous_one_is_still_applying_is_retried() -> None:
    sandbox, raw = make(PYPI_ONLY, network_update_failures=[DaytonaConflictError(CONFLICT)])
    widened = PYPI_ONLY.with_hosts(["a.example.com"])

    await fast_retries(sandbox).apply_network_policy(widened)

    assert raw.network_updates == [
        {"network_block_all": False, "domain_allow_list": "pypi.org,a.example.com"}
    ]
    assert sandbox.network_policy == widened


async def test_an_update_refused_on_every_attempt_fails_and_keeps_the_old_policy() -> None:
    sandbox, raw = make(PYPI_ONLY)
    attempts = sandbox._NETWORK_UPDATE_ATTEMPTS
    raw.network_update_failures = [DaytonaConflictError(CONFLICT) for _ in range(attempts)]

    with pytest.raises(DaytonaConflictError):
        await fast_retries(sandbox).apply_network_policy(NetworkPolicy())

    assert raw.network_update_failures == [] and raw.network_updates == []
    assert sandbox.network_policy == PYPI_ONLY


async def test_other_update_errors_are_not_retried() -> None:
    refusals: list[BaseException] = [
        DaytonaBadRequestError("Invalid domain"),
        DaytonaConflictError(CONFLICT),
    ]
    sandbox, raw = make(PYPI_ONLY, network_update_failures=refusals)

    with pytest.raises(DaytonaBadRequestError):
        await fast_retries(sandbox).apply_network_policy(NetworkPolicy())

    assert len(raw.network_update_failures) == 1
