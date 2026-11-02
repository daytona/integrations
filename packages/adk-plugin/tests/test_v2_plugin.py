"""Offline lifecycle translation checks; no sandbox is created."""

from unittest.mock import patch

from daytona_adk import DaytonaPlugin


def test_create_translates_minutes_when_intervals_are_positive():
    # Given
    with patch("daytona_adk.plugin.Daytona") as client:
        # When
        DaytonaPlugin(image="img_fixture", env_vars={"X": "Y"}, labels={"test": "offline"}, auto_stop_interval=3, auto_delete_interval=20)
        # Then
        call = client.return_value.v2.create.call_args
        assert call.args == ("img_fixture",)
        assert call.kwargs == {
            "name": None, "env": {"X": "Y"}, "labels": {"test": "offline"},
            "lifecycle_policy": {"idle_expiry_seconds": 180, "on_idle_timeout": "delete", "timeout_seconds": 1200, "on_timeout": "delete"},
        }


def test_create_disables_idle_when_auto_stop_is_zero():
    # Given
    with patch("daytona_adk.plugin.Daytona") as client:
        # When
        DaytonaPlugin(auto_stop_interval=0, auto_delete_interval=-1)
        # Then
        assert client.return_value.v2.create.call_args.kwargs["lifecycle_policy"] == {"idle_expiry_seconds": -1}
