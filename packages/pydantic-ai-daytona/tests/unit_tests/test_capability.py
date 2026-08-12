"""Unit tests for DaytonaSandbox capability configuration and validation."""

from typing import Any

import pytest

from pydantic_ai_daytona import DaytonaSandbox, DaytonaSandboxSession
from pydantic_ai_daytona._toolset import DaytonaSandboxToolset


def build(**kwargs: Any) -> DaytonaSandbox[None]:
    """Construct a capability from intentionally arbitrary (possibly invalid) kwargs."""
    return DaytonaSandbox(**kwargs)


class TestModeValidation:
    def test_defaults_are_valid(self) -> None:
        DaytonaSandbox()

    def test_snapshot_and_image_are_exclusive(self) -> None:
        with pytest.raises(ValueError, match="mutually exclusive"):
            DaytonaSandbox(snapshot="my-snapshot", image="python:3.12-slim")

    def test_attach_rejects_creation_settings(self) -> None:
        with pytest.raises(ValueError, match="snapshot.*only apply when creating"):
            DaytonaSandbox(sandbox_id="sb-123", snapshot="my-snapshot")

    def test_attach_rejects_env(self) -> None:
        with pytest.raises(ValueError, match="env"):
            DaytonaSandbox(sandbox_id="sb-123", env={"A": "1"})

    def test_attach_allows_workdir_and_credentials(self) -> None:
        DaytonaSandbox(sandbox_id="sb-123", workdir="/workspace", api_key="key")

    def test_attach_rejects_network_and_label_settings(self) -> None:
        with pytest.raises(ValueError, match="network_block_all"):
            DaytonaSandbox(sandbox_id="sb-123", network_block_all=True)
        with pytest.raises(ValueError, match="labels"):
            DaytonaSandbox(sandbox_id="sb-123", labels={"team": "ai"})

    def test_explicit_false_booleans_are_allowed_in_reuse_modes(self) -> None:
        DaytonaSandbox(sandbox_id="sb-123", ephemeral=False, network_block_all=False)
        DaytonaSandbox(session=DaytonaSandboxSession(), ephemeral=False)

    def test_attach_still_rejects_true_booleans(self) -> None:
        with pytest.raises(ValueError, match="ephemeral"):
            DaytonaSandbox(sandbox_id="sb-123", ephemeral=True)

    def test_attach_rejects_zero_intervals(self) -> None:
        with pytest.raises(ValueError, match="auto_stop_interval"):
            DaytonaSandbox(sandbox_id="sb-123", auto_stop_interval=0)

    def test_session_rejects_sandbox_id(self) -> None:
        session = DaytonaSandboxSession()
        with pytest.raises(ValueError, match="sandbox_id.*cannot be combined with `session`"):
            DaytonaSandbox(session=session, sandbox_id="sb-123")

    def test_session_rejects_credentials(self) -> None:
        session = DaytonaSandboxSession()
        with pytest.raises(ValueError, match="api_key"):
            DaytonaSandbox(session=session, api_key="key")

    def test_session_alone_is_valid(self) -> None:
        DaytonaSandbox(session=DaytonaSandboxSession())


class TestLimitValidation:
    @pytest.mark.parametrize(
        "field", ["max_command_timeout", "max_output_bytes", "max_output_lines", "max_read_bytes"]
    )
    def test_rejects_non_positive_int(self, field: str) -> None:
        with pytest.raises(ValueError, match=f"{field} must be a positive integer"):
            build(**{field: 0})

    def test_rejects_bool_masquerading_as_int(self) -> None:
        with pytest.raises(ValueError, match="max_output_lines"):
            build(max_output_lines=True)

    def test_rejects_non_positive_default_timeout(self) -> None:
        with pytest.raises(ValueError, match="default_command_timeout"):
            build(default_command_timeout=0)

    def test_rejects_infinite_default_timeout(self) -> None:
        with pytest.raises(ValueError, match="default_command_timeout"):
            build(default_command_timeout=float("inf"))

    def test_rejects_non_int_auto_stop_interval(self) -> None:
        with pytest.raises(ValueError, match="auto_stop_interval"):
            build(auto_stop_interval=1.5)

    def test_rejects_ephemeral_with_auto_delete_interval(self) -> None:
        with pytest.raises(ValueError, match="ephemeral already deletes"):
            DaytonaSandbox(ephemeral=True, auto_delete_interval=5)

    def test_ephemeral_false_allows_auto_delete_interval(self) -> None:
        DaytonaSandbox(ephemeral=False, auto_delete_interval=5)

    def test_rejects_non_string_instructions(self) -> None:
        with pytest.raises(ValueError, match="instructions"):
            build(instructions=42)

    def test_env_is_copied(self) -> None:
        env = {"A": "1"}
        capability = DaytonaSandbox(env=env)
        env["B"] = "2"
        assert capability.env == {"A": "1"}


class TestInstructions:
    def test_owned_mode_mentions_reset(self) -> None:
        text = DaytonaSandbox().get_instructions()
        assert text is not None
        assert "reset between runs" in text
        assert "60s" in text
        assert "300s" in text

    def test_attached_mode_mentions_persistence(self) -> None:
        text = DaytonaSandbox(sandbox_id="sb-123").get_instructions()
        assert text is not None
        assert "persists across runs" in text

    def test_default_timeout_clamped_to_ceiling(self) -> None:
        text = DaytonaSandbox(default_command_timeout=500.0, max_command_timeout=120).get_instructions()
        assert text is not None
        assert "after 120s" in text
        assert "up to 120s" in text

    def test_custom_instructions_used_verbatim(self) -> None:
        assert DaytonaSandbox(instructions="use it wisely").get_instructions() == "use it wisely"

    def test_empty_instructions_disable(self) -> None:
        assert DaytonaSandbox(instructions="").get_instructions() is None


class TestGetToolset:
    def test_builds_toolset_with_all_tools(self) -> None:
        toolset = DaytonaSandbox().get_toolset()
        assert isinstance(toolset, DaytonaSandboxToolset)
        assert set(toolset.tools) == {"run_command", "read_file", "write_file", "list_directory"}
