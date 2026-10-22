"""AgentEnv's bundled hello task through the real ``agent-env`` CLI, on Daytona."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from tests.integration_tests.conftest import CONFIG, LIVE

pytestmark = [LIVE]


def run_hello(project: Path, config: str) -> subprocess.CompletedProcess[str]:
    (project / ".agentenv").mkdir(parents=True, exist_ok=True)
    (project / ".agentenv" / "config.toml").write_text(config)
    env = {key: value for key, value in os.environ.items() if key != "AGENT_ENV_CONFIG"}
    return subprocess.run(
        [sys.executable, "-m", "agent_env.cli", "run", "hello", "--sandbox", "daytona"],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        timeout=1800,
    )


def test_hello_passes_on_daytona_and_tears_its_sandbox_down(
    tmp_path: Path, live_config: Path
) -> None:
    result = run_hello(
        tmp_path, '[sandbox]\ndefault = "daytona"\nagent_default = "daytona"\n\n' + CONFIG
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "passed" in result.stdout and "Tore down 1 sandbox." in result.stdout
    assert "Unclosed client session" not in result.stderr
    assert "Task was destroyed" not in result.stderr


def test_a_rejected_api_key_fails_the_run_without_creating_anything(
    tmp_path: Path, live_config: Path
) -> None:
    os.environ["DAYTONA_BOGUS_KEY"] = "dtn_not_a_real_key_0000000000000000"
    try:
        result = run_hello(tmp_path, CONFIG.replace("DAYTONA_API_KEY", "DAYTONA_BOGUS_KEY"))
    finally:
        del os.environ["DAYTONA_BOGUS_KEY"]

    assert result.returncode != 0
    assert "passed" not in result.stdout.split("Tasks:")[-1]
