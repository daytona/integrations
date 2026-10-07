"""Starting Chromium inside a Daytona sandbox and finding the debugging port it bound.

Everything here talks to the sandbox and to the process in it; nothing touches Playwright, the
driver or its tabs, so `browser.py` hands it a sandbox and a profile and gets back a port.
"""

from __future__ import annotations

import shlex
import time
from typing import Optional

from daytona import Sandbox, SessionExecuteRequest

ACTIVE_PORT_FILE = "DevToolsActivePort"
"""Chromium writes the debugging port it bound into this file in its user-data-dir."""
START_TIMEOUT = 30.0
"""Seconds Chromium gets to come up and answer on its debugging port."""
POLL = 0.5


def launch(
    sandbox: Sandbox,
    *,
    chromium: str,
    headless: bool,
    session_id: str,
    profile: str,
    download_dir: str,
    viewport: tuple[int, int],
) -> int:
    """Start Chromium in `sandbox` with a fresh profile and a scrubbed environment, and return the
    debugging port it bound (loopback only inside the sandbox).

    The browser runs under a background session command, not `process.exec`, which would block for
    as long as the browser lives.
    """
    width, height = viewport
    is_root = sandbox.process.exec("id -u").result.strip() == "0"
    flags = [
        *(["--headless=new"] if headless else []),
        # Port 0: the kernel picks one that is free, so a sandbox that already runs a browser of
        # its own cannot be collided with, and Chromium reports its choice in DevToolsActivePort.
        "--remote-debugging-port=0",
        f"--user-data-dir={profile}",
        f"--window-size={width},{height}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--password-store=basic",
        "--enable-features=LocalNetworkAccessChecks",
        # Pages restored from the back-forward cache fire no load events to wait for.
        "--disable-features=BackForwardCache",
        # Chromium's sandbox cannot start as root; the Daytona sandbox is then the isolation.
        *(["--no-sandbox"] if is_root else []),
        "about:blank",
    ]
    env = ["HOME=" + profile, "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"]
    if not headless:
        env.append("DISPLAY=:0")
    dirs = " ".join(shlex.quote(d) for d in (profile, download_dir))
    active = shlex.quote(f"{profile}/{ACTIVE_PORT_FILE}")
    sandbox.process.exec(f"mkdir -p -m 700 {dirs} && rm -f -- {active}")
    command = (
        f"env -i {' '.join(shlex.quote(e) for e in env)} {shlex.quote(chromium)} "
        f"{' '.join(shlex.quote(f) for f in flags)} >{shlex.quote(profile)}/chromium.log 2>&1"
    )
    sandbox.process.create_session(session_id)
    sandbox.process.execute_session_command(
        session_id, SessionExecuteRequest(command=command, run_async=True)
    )
    deadline = time.monotonic() + START_TIMEOUT
    while True:
        port = bound_port(sandbox, active)
        if port is not None:
            return port
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"Chromium did not start in the sandbox; see {profile}/chromium.log there"
            )
        time.sleep(POLL)


def bound_port(sandbox: Sandbox, active: str) -> Optional[int]:
    """The debugging port Chromium bound, once it answers there, or `None` while it is starting.

    Chromium writes the port it chose, with the browser's websocket path, into
    `DevToolsActivePort` in its user-data-dir. That directory is the driver's own fresh profile, so
    reading the port back from it is what proves the endpoint answering belongs to the Chromium
    this launch started — on a borrowed sandbox another browser may already be listening, and
    probing a port the driver merely guessed would otherwise hand the model someone else's pages.

    Args:
        active: The shell-quoted path of the profile's `DevToolsActivePort`.
    """
    read = sandbox.process.exec(f"head -n 1 -- {active} 2>/dev/null")
    line = (read.result or "").partition("\n")[0].strip()
    if read.exit_code != 0 or not line.isdigit():
        return None
    port = int(line)
    probe = f"curl -sf -o /dev/null http://127.0.0.1:{port}/json/version"
    return port if sandbox.process.exec(probe).exit_code == 0 else None
