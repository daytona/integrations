"""SDK clients are per event loop and closed when the loop shuts down, even if nobody calls close()."""

import asyncio

from agentenv_daytona.lifecycle import Clients
from tests.unit_tests.fakes import FakeDaytona


def _make(made: list[FakeDaytona]) -> FakeDaytona:
    made.append(FakeDaytona())
    return made[-1]


def test_a_client_is_closed_when_asyncio_run_shuts_its_loop_down() -> None:
    made: list[FakeDaytona] = []
    clients = Clients(lambda: _make(made))

    async def use() -> None:
        assert clients.current() is clients.current()

    asyncio.run(use())

    assert len(made) == 1 and made[0].closed


def test_each_loop_gets_its_own_client() -> None:
    made: list[FakeDaytona] = []
    clients = Clients(lambda: _make(made))

    async def use() -> None:
        clients.current()

    asyncio.run(use())
    asyncio.run(use())

    assert len(made) == 2 and all(client.closed for client in made)


async def test_close_closes_the_current_loops_client_and_a_later_use_makes_a_new_one() -> None:
    made: list[FakeDaytona] = []
    clients = Clients(lambda: _make(made))
    first = clients.current()

    await clients.close()

    assert first.closed and clients.current() is not first


def test_a_client_outlives_the_provider_that_made_it_and_closes_at_loop_shutdown() -> None:
    import gc

    made: list[FakeDaytona] = []

    def factory() -> FakeDaytona:
        made.append(FakeDaytona())
        return made[-1]

    async def use() -> None:
        # AgentEnv builds a throwaway provider per step and never closes it.
        Clients(factory, key="settings-a").current()
        gc.collect()
        await asyncio.sleep(0)
        assert Clients(factory, key="settings-a").current() is made[0]

    asyncio.run(use())

    assert len(made) == 1 and made[0].closed
