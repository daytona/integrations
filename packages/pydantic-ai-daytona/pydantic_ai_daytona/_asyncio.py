"""Finish resource acquisition/cleanup before delivering cancellation (inspired by Pydantic's harness)."""

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

T = TypeVar("T")


async def run_to_completion(work: Awaitable[T]) -> T:
    """Keep a strong task reference and defer even repeated caller cancellation."""
    task = asyncio.ensure_future(work)
    cancellation: asyncio.CancelledError | None = None
    while not task.done():
        try:
            await asyncio.wait((task,))
        except asyncio.CancelledError as error:
            cancellation = error
    if cancellation is not None:
        if not task.cancelled():
            task.exception()
        raise cancellation
    return task.result()
