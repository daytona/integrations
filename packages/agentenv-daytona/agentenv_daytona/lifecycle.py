"""Creating Daytona sandboxes without leaking any: rate-limit retries, and cleanup when a create is
cancelled or fails after Daytona already made the sandbox.

A cancelled caller gets its ``CancelledError`` at once, while the create it started is left to finish
and its sandbox, which nothing else holds, is deleted. A failed create may still have made a sandbox
(its response lost, or start timed out), so the sandbox's unique name is looked up and deleted.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from collections.abc import Callable, Hashable, Mapping
from dataclasses import dataclass
from typing import Any

from daytona import (
    DaytonaAuthenticationError,
    DaytonaAuthorizationError,
    DaytonaBadRequestError,
    DaytonaConflictError,
    DaytonaForbiddenError,
    DaytonaNotFoundError,
    DaytonaRateLimitError,
    DaytonaUnprocessableEntityError,
    DaytonaValidationError,
)

logger = logging.getLogger(__name__)

_reapers: set[asyncio.Task[None]] = set()
# The API refused the request itself, so no sandbox exists to clean up.
_REJECTED = (
    DaytonaAuthenticationError,
    DaytonaAuthorizationError,
    DaytonaForbiddenError,
    DaytonaBadRequestError,
    DaytonaUnprocessableEntityError,
    DaytonaValidationError,
)


@dataclass
class _Client:
    sdk: Any
    closed: bool = False
    keeper: asyncio.Task[None] | None = None

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            await self.sdk.close()


# Clients live as long as their event loop, not as long as the provider that asked for one: AgentEnv
# builds a throwaway provider per step. Keeper tasks are held here so none is collected while pending.
_shared: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[Hashable, _Client]] = (
    weakref.WeakKeyDictionary()
)
_keepers: set[asyncio.Task[None]] = set()


class Clients:
    """One SDK client per event loop and ``key`` (the provider's settings), shared by every provider
    instance, as an ``AsyncDaytona`` holds an HTTP session bound to its loop.

    AgentEnv seldom closes a sandbox provider, so each client is also closed when its loop shuts down:
    a keeper task waits forever and closes the client in its ``finally``, which runs when
    ``asyncio.run`` cancels the tasks still pending at its end.
    """

    def __init__(self, factory: Callable[[], Any], *, key: Hashable = None):
        self._factory = factory
        self._key = key

    def current(self) -> Any:
        loop = asyncio.get_running_loop()
        clients = _shared.setdefault(loop, {})
        if self._key not in clients:
            client = clients[self._key] = _Client(self._factory())
            client.keeper = loop.create_task(_close_at_shutdown(client))
            _keepers.add(client.keeper)
            client.keeper.add_done_callback(_keepers.discard)
        return clients[self._key].sdk

    async def close(self) -> None:
        client = _shared.get(asyncio.get_running_loop(), {}).pop(self._key, None)
        if client is not None:
            if client.keeper is not None:
                client.keeper.cancel()
                await asyncio.gather(client.keeper, return_exceptions=True)
            await client.close()


async def _close_at_shutdown(client: _Client) -> None:
    try:
        await asyncio.Event().wait()
    finally:
        await client.close()


@dataclass(frozen=True)
class Retry:
    """How rate-limited creates are retried and how hard cleanup tries."""

    attempts: int
    base_delay: float
    reclaim_attempts: int
    reclaim_delay: float


def _retry_after(headers: Mapping[str, Any] | None) -> float | None:
    """The server's ``Retry-After*`` hint in seconds, when it sends one."""
    for key, value in (headers or {}).items():
        if str(key).lower().startswith("retry-after"):
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
    return None


async def delete_named(client: Any, name: str, retry: Retry) -> None:
    """Delete the sandbox called ``name`` if Daytona made one; logged by name if that can't be confirmed."""
    for attempt in range(retry.reclaim_attempts):
        try:
            await (await client.get(name)).delete()
            logger.info("Deleted Daytona sandbox %s, made by a create that did not complete", name)
            return
        except (DaytonaNotFoundError, DaytonaConflictError):
            return
        except (
            Exception
        ) as exc:  # noqa: BLE001 - retried, then reported; never masks the caller's error
            logger.warning(
                "Cleaning up Daytona sandbox %s failed (attempt %s): %s", name, attempt + 1, exc
            )
            await asyncio.sleep(retry.reclaim_delay * 2**attempt)
    logger.error(
        "A Daytona sandbox named %s may be left running until its TTL; delete it by name", name
    )


def _reap_when_done(client: Any, task: asyncio.Future[Any], name: str, retry: Retry) -> None:
    def reap(done: asyncio.Future[Any]) -> None:
        if done.cancelled() or done.exception() is not None:
            cleanup = delete_named(client, name, retry)
        else:
            cleanup = delete_sandbox(done.result(), name, retry)
        reaper = asyncio.ensure_future(cleanup)
        _reapers.add(reaper)
        reaper.add_done_callback(_reapers.discard)

    task.add_done_callback(reap)


async def delete_sandbox(raw: Any, name: str, retry: Retry) -> None:
    """Delete ``raw``, retrying through brief API failures; gone or already going counts as deleted."""
    for attempt in range(retry.reclaim_attempts):
        try:
            await raw.delete()
            return
        except (DaytonaNotFoundError, DaytonaConflictError):
            return
        except Exception as exc:  # noqa: BLE001 - retried, then reported; the TTL is the backstop
            logger.warning(
                "Deleting Daytona sandbox %s failed (attempt %s): %s", name, attempt + 1, exc
            )
            await asyncio.sleep(retry.reclaim_delay * 2**attempt)
    logger.error(
        "Daytona sandbox %s could not be deleted and runs until its TTL; delete it by name", name
    )


async def create(client: Any, params: Any, *, timeout: float, retry: Retry) -> Any:
    """``client.create(params)``, retried while rate limited, leaving no sandbox behind on failure."""
    name = params.name
    for attempt in range(retry.attempts):
        task = asyncio.ensure_future(client.create(params, timeout=timeout))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done() and not task.cancelled() and task.exception() is None:
                await delete_sandbox(task.result(), name, retry)
            elif not task.done():
                _reap_when_done(client, task, name, retry)
            raise
        except DaytonaRateLimitError as exc:
            if attempt + 1 == retry.attempts:
                raise
            delay = _retry_after(exc.headers) or retry.base_delay * 2**attempt
            logger.warning("Daytona rate-limited a sandbox create; retrying in %ss", delay)
            await asyncio.sleep(min(delay, 60))
        except _REJECTED:
            raise
        except BaseException:
            await delete_named(client, name, retry)
            raise
    raise AssertionError("unreachable")
