"""Daytona sandbox capability that gives agents a cloud sandbox to work in."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT
from pydantic_ai.toolsets import AgentToolset

from pydantic_ai_daytona._session import DaytonaSandboxSession
from pydantic_ai_daytona._tool_output import DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES
from pydantic_ai_daytona._toolset import DaytonaSandboxToolset

_DEFAULT_MAX_COMMAND_TIMEOUT = 300
_DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024

_OWNED_INSTRUCTIONS = (
    "You have a Daytona sandbox: an isolated, ephemeral cloud environment. Use `run_command` "
    "to run shell commands in it, and `read_file` / `write_file` / `list_directory` to manage "
    "files. Commands run through a shell, so pipes and redirection work. A command times out "
    "after {default_timeout}s unless you pass `timeout_seconds` (up to {max_timeout}s). The "
    "sandbox is reset between runs, so persist anything important outside it."
)

_ATTACHED_INSTRUCTIONS = (
    "You have a Daytona sandbox: an isolated cloud environment. Use `run_command` to run "
    "shell commands in it, and `read_file` / `write_file` / `list_directory` to manage files. "
    "Commands run through a shell, so pipes and redirection work. A command times out after "
    "{default_timeout}s unless you pass `timeout_seconds` (up to {max_timeout}s). This sandbox "
    "persists across runs, so files from earlier runs can still be present."
)


@dataclass(kw_only=True)
class DaytonaSandbox(AbstractCapability[AgentDepsT]):
    """Access to an isolated cloud sandbox powered by [Daytona](https://www.daytona.io).

    Gives the agent tools to run commands and manage files inside a Daytona sandbox,
    a place to execute untrusted or model-generated code without touching the host.
    By default each run gets a fresh sandbox (created from `snapshot`, `image`, or the
    Daytona default snapshot) that is deleted when the run ends. To keep one sandbox
    across runs, either set `sandbox_id` to attach to a sandbox you manage elsewhere,
    or pass a `session` you own (an entered `DaytonaSandboxSession`) so you control its
    lifetime. The capability never opens or terminates a `session` you pass.

    Requires Daytona credentials: set `DAYTONA_API_KEY` in the environment (see
    https://app.daytona.io/dashboard/keys) or pass `api_key`.

    ```python
    from pydantic_ai import Agent
    from pydantic_ai_daytona import DaytonaSandbox

    agent = Agent('anthropic:claude-sonnet-4-6', capabilities=[DaytonaSandbox()])
    result = agent.run_sync('Write a Python script that prints the first 10 primes and run it.')
    print(result.output)
    ```
    """

    snapshot: str | None = None
    """Daytona snapshot to create owned sandboxes from (None uses the Daytona default).

    Mutually exclusive with `image`.
    """

    image: str | None = None
    """Container image to create owned sandboxes from, as a registry tag (e.g. `python:3.12-slim`).

    Daytona builds a sandbox directly from the image. Mutually exclusive with `snapshot`;
    prefer `snapshot` for faster startup.
    """

    sandbox_id: str | None = None
    """Attach to an existing sandbox by id instead of creating one.

    Attached sandboxes are started if stopped, and are never deleted by the capability.
    The settings that only apply when creating a sandbox (`snapshot`, `image`, `env`,
    `auto_stop_interval`, `auto_delete_interval`) cannot be combined with `sandbox_id`.
    """

    session: DaytonaSandboxSession | None = None
    """Use a sandbox session you own and keep open across runs, instead of a per-run one.

    Pass an already-entered `DaytonaSandboxSession` to reuse one sandbox across runs while
    controlling its lifetime yourself: the capability uses it but never opens or closes it.
    Cannot be combined with any of the sandbox selection or creation settings (the session
    already owns those). A shared session is not concurrency-safe across overlapping runs.
    """

    env: Mapping[str, str] | None = None
    """Environment variables to set in an owned sandbox.

    Owned sandboxes only. For an attached or injected sandbox, set variables when you
    create that sandbox yourself.
    """

    workdir: str | None = None
    """Working directory for commands and relative file paths (the sandbox default when None)."""

    labels: Mapping[str, str] | None = None
    """Labels to attach to an owned sandbox (e.g. for cost attribution or filtering)."""

    os_user: str | None = None
    """OS user commands run as in an owned sandbox (the Daytona default user when None)."""

    ephemeral: bool | None = None
    """If True, Daytona deletes an owned sandbox as soon as it stops.

    Shorthand for `auto_delete_interval=0`, so it cannot be combined with
    `auto_delete_interval`. A stronger cleanup backstop for per-run sandboxes.
    """

    network_block_all: bool | None = None
    """Block all outbound network access from an owned sandbox.

    Recommended when the agent runs fully untrusted code that does not need the network.
    """

    network_allow_list: str | None = None
    """Comma-separated CIDR list an owned sandbox may reach (all other traffic follows
    `network_block_all`)."""

    domain_allow_list: str | None = None
    """Comma-separated domain list an owned sandbox may reach."""

    auto_stop_interval: int | None = None
    """Minutes of inactivity before Daytona stops an owned sandbox (None uses the Daytona default).

    Owned sandboxes are deleted when the run ends; this is the server-side backstop for
    sandboxes orphaned by a crash. Set `0` to disable auto-stop.
    """

    auto_delete_interval: int | None = None
    """Minutes after stopping before Daytona deletes an owned sandbox (None uses the Daytona default).

    Set `0` to delete immediately on stop; negative values disable auto-deletion.
    """

    api_key: str | None = None
    """Daytona API key (falls back to the `DAYTONA_API_KEY` environment variable)."""

    api_url: str | None = None
    """Daytona API URL (falls back to `DAYTONA_API_URL`, then the Daytona default)."""

    target: str | None = None
    """Daytona target region (falls back to `DAYTONA_TARGET`, then the Daytona default)."""

    default_command_timeout: float = 60.0
    """Default timeout in seconds for one `run_command`, used when the model omits one."""

    max_command_timeout: int = _DEFAULT_MAX_COMMAND_TIMEOUT
    """Hard ceiling in seconds for any single `run_command`, including a model-supplied
    `timeout_seconds`."""

    max_output_bytes: int = DEFAULT_MAX_BYTES
    """Maximum payload retained per command output or file read, measured in UTF-8 bytes.

    Whichever of `max_output_bytes` and `max_output_lines` is reached first wins.
    """

    max_output_lines: int = DEFAULT_MAX_LINES
    """Maximum payload lines retained per command output or file read, alongside `max_output_bytes`."""

    max_read_bytes: int = _DEFAULT_MAX_READ_BYTES
    """Largest file `read_file` will read whole; larger files are refused with a hint to
    use shell tools."""

    instructions: str | None = None
    """Instructions telling the model how to use the sandbox, added to the system prompt.

    Leave as `None` for a default that matches the mode (fresh sandbox per run, or a
    reused one that can carry files from earlier runs) and states the command timeout
    and its ceiling. Set `''` to add no instructions, or pass your own text.
    """

    def __post_init__(self) -> None:
        self._validate_limits()
        if self.env is not None:
            self.env = dict(self.env)
        if self.labels is not None:
            self.labels = dict(self.labels)
        if self.snapshot is not None and self.image is not None:
            raise ValueError("snapshot and image are mutually exclusive; pass at most one.")
        # The SDK treats `ephemeral` as `auto_delete_interval=0` and silently overrides a
        # conflicting interval with only a warning; fail fast here instead.
        if self.ephemeral and self.auto_delete_interval is not None:
            raise ValueError(
                "ephemeral already deletes the sandbox when it stops (auto_delete_interval=0); "
                "drop auto_delete_interval or set ephemeral=False."
            )

        # There are three modes: owned (the default), attach (`sandbox_id`), and injected
        # (`session`). Attach and injected both reuse an existing sandbox, so any setting
        # that only affects sandbox creation is rejected in those modes rather than
        # silently dropped.
        if self.session is not None:
            conflicts = self._non_default_reused_settings()
            if conflicts:
                raise ValueError(
                    f'{", ".join(conflicts)} cannot be combined with `session`, which already '
                    "owns the sandbox and its configuration."
                )
            return
        if self.sandbox_id is not None:
            ignored = self._non_default_owned_settings()
            if ignored:
                raise ValueError(
                    f'{", ".join(ignored)} only apply when creating a sandbox, but `sandbox_id` '
                    "attaches to an existing one. Remove them, or drop `sandbox_id` to create "
                    "a sandbox."
                )

    def _validate_limits(self) -> None:
        for name, value in (
            ("max_command_timeout", self.max_command_timeout),
            ("max_output_bytes", self.max_output_bytes),
            ("max_output_lines", self.max_output_lines),
            ("max_read_bytes", self.max_read_bytes),
        ):
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name} must be a positive integer, got {value!r}.")

        timeout = self.default_command_timeout
        if type(timeout) is bool or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError(
                f"default_command_timeout must be a positive finite number, got {timeout!r}."
            )

        for name, interval in (
            ("auto_stop_interval", self.auto_stop_interval),
            ("auto_delete_interval", self.auto_delete_interval),
        ):
            if interval is not None and type(interval) is not int:
                raise ValueError(f"{name} must be an integer or None, got {interval!r}.")

        # Validated explicitly because the agent-spec path does not type-check
        # custom-capability dataclass fields; a bad value should fail here, not
        # deep in the agent build.
        if self.instructions is not None and type(self.instructions) is not str:
            raise ValueError(f"instructions must be a string or None, got {self.instructions!r}.")

    def _non_default_owned_settings(self) -> list[str]:
        return [
            name
            for name, value in (
                ("snapshot", self.snapshot),
                ("image", self.image),
                ("env", self.env),
                ("labels", self.labels),
                ("os_user", self.os_user),
                ("ephemeral", self.ephemeral),
                ("network_block_all", self.network_block_all),
                ("network_allow_list", self.network_allow_list),
                ("domain_allow_list", self.domain_allow_list),
                ("auto_stop_interval", self.auto_stop_interval),
                ("auto_delete_interval", self.auto_delete_interval),
            )
            if value is not None
        ]

    def _non_default_reused_settings(self) -> list[str]:
        conflicts = self._non_default_owned_settings()
        for name, value in (
            ("sandbox_id", self.sandbox_id),
            ("workdir", self.workdir),
            ("api_key", self.api_key),
            ("api_url", self.api_url),
            ("target", self.target),
        ):
            if value is not None:
                conflicts.append(name)
        return conflicts

    def get_instructions(self) -> str | None:
        """Explain the sandbox to the model, unless overridden or disabled via `instructions`."""
        if self.instructions is not None:
            return self.instructions or None
        reused = self.sandbox_id is not None or self.session is not None
        template = _ATTACHED_INSTRUCTIONS if reused else _OWNED_INSTRUCTIONS
        # Report the deadline the toolset will actually apply (rounded up and clamped,
        # see `DaytonaSandboxToolset._command_timeout`), so the numbers cannot
        # contradict behavior.
        default_timeout = min(
            max(1, math.ceil(self.default_command_timeout)), self.max_command_timeout
        )
        return template.format(default_timeout=default_timeout, max_timeout=self.max_command_timeout)

    def get_toolset(self) -> AgentToolset[AgentDepsT]:
        """Build and return the Daytona sandbox toolset."""
        return DaytonaSandboxToolset[AgentDepsT](
            snapshot=self.snapshot,
            image=self.image,
            sandbox_id=self.sandbox_id,
            env=self.env,
            workdir=self.workdir,
            labels=self.labels,
            os_user=self.os_user,
            ephemeral=self.ephemeral,
            network_block_all=self.network_block_all,
            network_allow_list=self.network_allow_list,
            domain_allow_list=self.domain_allow_list,
            auto_stop_interval=self.auto_stop_interval,
            auto_delete_interval=self.auto_delete_interval,
            api_key=self.api_key,
            api_url=self.api_url,
            target=self.target,
            default_command_timeout=self.default_command_timeout,
            max_command_timeout=self.max_command_timeout,
            max_output_bytes=self.max_output_bytes,
            max_output_lines=self.max_output_lines,
            max_read_bytes=self.max_read_bytes,
            session=self.session,
        )
