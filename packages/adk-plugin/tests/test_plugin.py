"""Offline check that DaytonaPlugin reaches its sandbox through the SDK 2.x `v0` namespace."""

from unittest.mock import MagicMock, patch

import daytona

from daytona_adk import DaytonaPlugin


def test_plugin_creates_and_deletes_its_sandbox_through_v0() -> None:
    # Spec'd on the real SDK 2.x root client, which has no create() or delete():
    # a call that skips `.v0` raises AttributeError instead of passing.
    client = MagicMock(spec=daytona.Daytona)
    with patch("daytona_adk.plugin.Daytona", return_value=client):
        plugin = DaytonaPlugin(api_key="test-key")

    client.v0.create.assert_called_once()
    plugin.destroy_sandbox()
    client.v0.delete.assert_called_once_with(client.v0.create.return_value)
