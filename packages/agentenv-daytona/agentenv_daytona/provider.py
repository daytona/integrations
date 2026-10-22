"""The ``daytona`` AgentEnv sandbox provider.

Every sandbox is an ephemeral, public Daytona sandbox booted from the Docker host image (built and
cached by Daytona) or a configured snapshot, with AgentEnv's ``timeout`` as its hard lifetime. The
preview proxy domain is learned from Daytona, never written down, and allowed in restricted sandboxes.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any, ClassVar, Self

from agent_env.attribution import PIPELINE_STEP_KEY, RUN_ID_KEY, Attribution
from agent_env.providers.sandbox_providers.sandbox import (
    NetworkPolicy,
    NetworkPolicyUnsupportedError,
)
from agent_env.providers.sandbox_providers.sandbox_provider import (
    SandboxProvider,
    apply_default_attribution,
)
from daytona import AsyncDaytona, DaytonaBadRequestError, DaytonaConfig, DaytonaForbiddenError

from agentenv_daytona import lifecycle, preview_domain
from agentenv_daytona.config import (
    PORTS_LABEL,
    Settings,
    create_params,
    parse_settings,
    sandbox_labels,
    sandbox_name,
    sandbox_resources,
    ttl_minutes,
)
from agentenv_daytona.network import create_fields, policy_from_sandbox, refusal
from agentenv_daytona.sandbox import DaytonaSandbox

logger = logging.getLogger(__name__)

SANDBOX_STARTED_EVENT = "agent_env.daytona_sandbox_started"
# Phrases of Daytona's refusals of a sandbox's egress lists (a Tier 1-2 organization, a list too long or
# malformed), as opposed to any other reason a create is refused.
_POLICY_REFUSALS = ("network access is restricted", "allow list", "allowlist", "invalid domain")


def forget_preview_hosts() -> None:
    """Drop every learned preview domain (for tests)."""
    preview_domain.forget()
    DaytonaSandboxProvider.EGRESS_HOSTS = ()


def _learn(pattern: str) -> None:
    if preview_domain.learn(pattern):
        # Published so allowlists built for other providers' workloads reach Daytona URLs too.
        DaytonaSandboxProvider.EGRESS_HOSTS = tuple(preview_domain.learned())


def _client(settings: Settings) -> Any:
    return AsyncDaytona(
        DaytonaConfig(api_key=settings.api_key, api_url=settings.api_url, target=settings.target)
    )


class DaytonaSandboxProvider(SandboxProvider):
    """Docker-capable Daytona sandboxes as AgentEnv VMs. ``api_key`` comes from the resolved config
    (an ``env:`` or ``secret:`` reference), never from the process environment."""

    EGRESS_HOSTS: ClassVar[tuple[str, ...]] = ()
    _RATE_LIMIT_ATTEMPTS = 5
    _RATE_LIMIT_BASE_DELAY = 2.0
    _RECLAIM_ATTEMPTS = 3
    _RECLAIM_DELAY = 1.0

    def __init__(
        self,
        settings: Settings,
        *,
        client_factory: Callable[[Settings], Any] = _client,
        fetch_template: Callable[[str], str] = preview_domain.fetch_proxy_template,
    ):
        self._settings = settings
        self._clients = lifecycle.Clients(
            lambda: client_factory(settings), key=(client_factory, settings)
        )
        self._fetch_template = fetch_template

    def __repr__(self) -> str:
        return f"DaytonaSandboxProvider(api_url={self._settings.api_url!r}, target={self._settings.target!r})"

    @classmethod
    def from_config(cls, **config: Any) -> Self:
        return cls(parse_settings(config))

    @classmethod
    def supports_network_policy(cls, policy: NetworkPolicy) -> bool:
        """Allow-all, or an allowlist of up to 100 hostnames (``*.`` wildcards allowed)."""
        return refusal(policy) is None

    @classmethod
    def effective_network_policy(cls, policy: NetworkPolicy | None) -> NetworkPolicy:
        """Every platform's hosts, as on the base, and the Daytona preview domains seen so far."""
        return super().effective_network_policy(policy).with_hosts(preview_domain.learned())

    async def close(self) -> None:
        await self._clients.close()

    async def _learn_from_api(self) -> None:
        """Learn the preview domain before the first restricted sandbox exists; best effort."""
        if preview_domain.learned():
            return
        try:
            template = await asyncio.to_thread(self._fetch_template, self._settings.api_url)
            _learn(preview_domain.pattern_from_template(template))
        except Exception as exc:  # noqa: BLE001 - each sandbox's own preview URL still teaches it
            logger.warning(
                "Could not read Daytona's preview domain from %s/config: %s",
                self._settings.api_url,
                exc,
            )

    async def _wrap(
        self, raw: Any, ports: list[int], policy: NetworkPolicy | None
    ) -> DaytonaSandbox:
        """``raw`` as a DaytonaSandbox, with its ports' preview URLs, its preview domain learned."""
        client = self._clients.current()
        urls = {port: (await raw.get_preview_link(port)).url for port in ports}
        sample = next(iter(urls.values()), None) or (await raw.get_preview_link(8080)).url
        _learn(preview_domain.preview_host_pattern(sample))

        async def read_raw() -> Any:
            return await client.get(raw.id)

        return DaytonaSandbox(raw, tunnel_urls=urls, network_policy=policy, read_raw=read_raw)

    async def create_vm(
        self,
        *,
        image: str | None = None,
        boot_mode: str | None = None,
        cpu: float = 1.0,
        memory: int = 8192,
        disk_size_gb: float = 10,
        timeout: int = 3600 * 2,
        exposed_ports: list[int] | None = None,
        setup_for_gateway: bool = True,
        attribution: Attribution | None = None,
        network_policy: NetworkPolicy | None = None,
    ) -> DaytonaSandbox:
        """Create a sandbox; ``timeout`` is its hard lifetime."""
        if image is not None:
            raise ValueError(
                "the Daytona provider boots its host image or snapshot; image overrides are unsupported"
            )
        if boot_mode is not None:
            logger.warning("Ignoring boot_mode=%s: Daytona sandboxes have no boot modes", boot_mode)
        if network_policy is not None and (reason := refusal(network_policy)):
            raise NetworkPolicyUnsupportedError(reason)
        if network_policy is not None and network_policy.restricts_egress:
            await self._learn_from_api()
        policy = self.effective_network_policy(network_policy).with_hosts(
            self._settings.egress_hosts
        )
        if reason := refusal(policy):
            raise NetworkPolicyUnsupportedError(reason)
        ports = list(dict.fromkeys(exposed_ports or []))
        defaults = apply_default_attribution(dict(attribution or {}))
        resolved = {key: str(value) for key, value in defaults.items() if value is not None}
        resources = sandbox_resources(cpu=cpu, memory_mb=memory, disk_gb=disk_size_gb)
        common = {
            "name": sandbox_name(resolved),
            "labels": sandbox_labels(resolved, ports, host_image=self._settings.snapshot is None),
            "public": True,
            "ephemeral": True,
            "auto_stop_interval": 0,
            "ttl_minutes": ttl_minutes(timeout),
            **create_fields(policy),
        }
        params, wait = create_params(self._settings, common, resources)
        if self._settings.snapshot:
            logger.info(
                "Daytona snapshot %s fixes the sandbox size; requested %s",
                self._settings.snapshot,
                resources,
            )
        retry = lifecycle.Retry(
            self._RATE_LIMIT_ATTEMPTS,
            self._RATE_LIMIT_BASE_DELAY,
            self._RECLAIM_ATTEMPTS,
            self._RECLAIM_DELAY,
        )
        try:
            raw = await lifecycle.create(self._clients.current(), params, timeout=wait, retry=retry)
        except (DaytonaForbiddenError, DaytonaBadRequestError) as exc:
            refusal_text = str(exc).lower()
            if policy.restricts_egress and any(
                phrase in refusal_text for phrase in _POLICY_REFUSALS
            ):
                raise NetworkPolicyUnsupportedError(
                    f"Daytona refused the egress policy: {exc}"
                ) from exc
            raise
        try:
            sandbox = await self._wrap(raw, ports, policy)
            await self._allow_own_preview_domain(sandbox)
            logger.info(
                "Daytona sandbox started: sandbox_id=%s cpu=%s memory=%sGiB disk=%sGiB attribution=%s",
                raw.id,
                resources.cpu,
                resources.memory,
                resources.disk,
                resolved,
                extra={
                    "event": SANDBOX_STARTED_EVENT,
                    "daytona_sandbox_id": raw.id,
                    "daytona_attribution": resolved,
                    PIPELINE_STEP_KEY: resolved.get(PIPELINE_STEP_KEY),
                    RUN_ID_KEY: resolved.get(RUN_ID_KEY),
                },
            )
            if setup_for_gateway:
                await sandbox.setup_vm_for_gateway(ports)
            return sandbox
        except BaseException:
            await lifecycle.delete_sandbox(raw, params.name or raw.id, retry)
            raise

    async def _allow_own_preview_domain(self, sandbox: DaytonaSandbox) -> None:
        """A restricted sandbox served on a preview domain its allowlist lacks gets it added."""
        policy = sandbox.network_policy
        if policy is None or not policy.restricts_egress:
            return
        if missing := [host for host in preview_domain.learned() if host not in policy.allow_hosts]:
            await sandbox.apply_network_policy(policy.with_hosts(missing))

    async def create_sandbox(
        self,
        *,
        image_name: str,
        port: int,
        env: dict[str, str],
        cpu: float = 1.0,
        memory: int = 8192,
        disk_size_gb: float = 10,
        timeout: int = 3600 * 2,
        attribution: Attribution | None = None,
        network_policy: NetworkPolicy | None = None,
    ) -> DaytonaSandbox:
        """A bare VM the caller loads and starts ``image_name`` in, as on the other VM providers."""
        del image_name, env
        return await self.create_vm(
            cpu=cpu,
            memory=memory,
            disk_size_gb=disk_size_gb,
            timeout=timeout,
            exposed_ports=[port],
            attribution=attribution,
            network_policy=network_policy,
        )

    async def get_sandbox(self, sandbox_id: str) -> DaytonaSandbox:
        """Reconnect, restoring ports, preview URLs and the applied egress policy."""
        raw = await self._clients.current().get(sandbox_id)
        labels = getattr(raw, "labels", None) or {}
        ports = [
            int(port)
            for port in str(labels.get(PORTS_LABEL, "")).split(",")
            if port.strip().isdigit()
        ]
        if (policy := policy_from_sandbox(raw)) is None:
            logger.warning(
                "Daytona sandbox %s applies an egress policy agent-env can't express", sandbox_id
            )
        sandbox = await self._wrap(raw, ports, policy)
        await self._allow_own_preview_domain(sandbox)
        return sandbox
