"""Moving bytes onto a Daytona sandbox, and letting a restricted sandbox reach its downloads.

Uploads go through Daytona's file API as parts in ``/tmp`` (the target may be root-owned), joined by
root and checked against the local sha256. A restricted sandbox's allowlist is widened by the hosts of
the signed URLs it is about to download from, under a per-sandbox lock, from the policy Daytona reports
rather than a cached copy, so concurrent downloads never drop each other's hosts.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import shlex
import time
import uuid
import weakref
from collections.abc import AsyncIterator
from typing import IO, TYPE_CHECKING
from urllib.parse import urlparse

from agentenv_daytona.network import policy_from_sandbox

if TYPE_CHECKING:
    from agentenv_daytona.sandbox import DaytonaSandbox

logger = logging.getLogger(__name__)

UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
_UPLOADS_IN_FLIGHT = 8
# The join rewrites the whole file, so retrying it after a dropped transport is safe.
_JOIN_RETRIES = 2
_EGRESS_PROPAGATION_TIMEOUT = 60
_EGRESS_PROBE_INTERVAL = 2
_EGRESS_PROBE_TIMEOUT = 5

_policy_locks: weakref.WeakValueDictionary[tuple[asyncio.AbstractEventLoop, str], asyncio.Lock] = (
    weakref.WeakValueDictionary()
)


async def read_parts(source: IO[bytes]) -> AsyncIterator[bytes]:
    """``source`` in upload-sized parts, read off the event loop."""
    while part := await asyncio.to_thread(source.read, UPLOAD_CHUNK_BYTES):
        yield part


async def upload(sandbox: DaytonaSandbox, parts: AsyncIterator[bytes], vm_path: str) -> None:
    """Upload ``parts`` several at once, join them as root at ``vm_path`` and check its sha256."""
    stem = f"/tmp/_ae_upload_{uuid.uuid4().hex[:12]}"
    digest = hashlib.sha256()
    gate = asyncio.Semaphore(_UPLOADS_IN_FLIGHT)
    count = 0

    async def put(path: str, part: bytes) -> None:
        try:
            await sandbox.raw.fs.upload_file(part, path)
        finally:
            gate.release()

    try:
        try:
            async with asyncio.TaskGroup() as group:
                async for part in parts:
                    await gate.acquire()
                    digest.update(part)
                    group.create_task(put(f"{stem}.{count}", part))
                    count += 1
        except ExceptionGroup as failed:
            raise failed.exceptions[0]
        quoted = shlex.quote(vm_path)
        last = max(count - 1, 0)
        join = f'for i in $(seq 0 {last}); do cat "{stem}.$i" || exit 1; done > {quoted} && sha256sum {quoted}'
        if count == 0:
            join = f": > {quoted} && sha256sum {quoted}"
        written = await sandbox.exec_script(join, max_retries=_JOIN_RETRIES)
    finally:
        if count:
            try:
                await sandbox.exec_script(
                    f'for i in $(seq 0 {count - 1}); do rm -f "{stem}.$i"; done'
                )
            except Exception as exc:  # noqa: BLE001 - leftover parts in /tmp go with the sandbox
                logger.warning("Removing upload parts %s.* failed (ignored): %s", stem, exc)
    actual = written.split()[0] if written.split() else ""
    if actual != digest.hexdigest():
        raise RuntimeError(
            f"{vm_path} in Daytona sandbox {sandbox.sandbox_id} does not match the upload: its sha256 is "
            f"{actual or 'missing'}, the upload's {digest.hexdigest()}"
        )


async def allow_hosts(sandbox: DaytonaSandbox, hosts: set[str]) -> None:
    """Add ``hosts`` to the sandbox's applied allowlist, if it has one, and wait until they answer."""
    if not hosts:
        return
    key = (asyncio.get_running_loop(), sandbox.sandbox_id)
    async with _policy_locks.setdefault(key, asyncio.Lock()):
        policy = policy_from_sandbox(await sandbox.read_raw())
        if policy is None:
            raise RuntimeError(
                f"Daytona sandbox {sandbox.sandbox_id} applies an egress policy agent-env cannot express, "
                "so it cannot be widened safely for downloads"
            )
        if not policy.restricts_egress:
            return
        new_hosts = sorted(hosts - set(policy.allow_hosts))
        if new_hosts:
            await sandbox.apply_network_policy(policy.with_hosts(new_hosts))
            await _wait_for_egress(sandbox, new_hosts)


def url_hosts(urls: list[str | None]) -> set[str]:
    return {parsed.hostname for url in urls if url and (parsed := urlparse(url)).hostname}


async def _wait_for_egress(sandbox: DaytonaSandbox, hosts: list[str]) -> None:
    """Wait until each host accepts a connection, since a policy change is not always instant."""
    deadline = time.monotonic() + _EGRESS_PROPAGATION_TIMEOUT
    probes = " && ".join(
        f"curl -s -o /dev/null --max-time {_EGRESS_PROBE_TIMEOUT} {shlex.quote(f'https://{host}/')}"
        for host in hosts
    )
    while (remaining := deadline - time.monotonic()) > 0:
        process = await sandbox.exec("sh", "-c", probes)
        if await process.wait() == 0:
            return
        await asyncio.sleep(min(_EGRESS_PROBE_INTERVAL, max(0.0, remaining)))
    logger.warning(
        "Daytona sandbox %s still cannot reach %s after %ss; continuing",
        sandbox.sandbox_id,
        hosts,
        _EGRESS_PROPAGATION_TIMEOUT,
    )
