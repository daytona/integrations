"""The package's import surface, checked in a subprocess with Playwright made unimportable.

`DaytonaComputer` needs no Playwright, so a computer-only install must be able to import the
package every way Python offers — including `from daytona_toolsets import *`, which loads every
name in `__all__` and would otherwise raise on the optional browser driver.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

WITHOUT_PLAYWRIGHT = """
import sys


class Blocker:
    def find_spec(self, name, path=None, target=None):
        if name == "playwright" or name.startswith("playwright."):
            raise ModuleNotFoundError("No module named 'playwright'")
        return None


sys.meta_path.insert(0, Blocker())
for module in [name for name in sys.modules if name.startswith("playwright")]:
    del sys.modules[module]
"""


def run(body: str) -> subprocess.CompletedProcess[str]:
    script = WITHOUT_PLAYWRIGHT + textwrap.dedent(body)
    return subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)


def test_import_star_does_not_need_the_browser_extra() -> None:
    """`import *` binds every name in `__all__`. With the browser driver in it, a computer-only
    install gets an ImportError instead of the names it can actually use."""
    done = run("""
        namespace: dict[str, object] = {}
        exec("from daytona_toolsets import *", namespace)
        exported = {name for name in namespace if not name.startswith("__")}
        assert exported == {
            "DaytonaComputer",
            "AsyncDaytonaComputer",
            "DaytonaFilePolicy",
        }, sorted(exported)
        print("OK")
        """)
    assert done.returncode == 0, done.stderr
    assert "OK" in done.stdout


def test_the_browser_driver_still_says_what_it_needs() -> None:
    """Leaving it out of `__all__` must not hide it: asking for it by name still works, and
    without the extra it still says which extra to install."""
    done = run("""
        import daytona_toolsets

        assert "DaytonaBrowser" not in daytona_toolsets.__all__
        try:
            daytona_toolsets.DaytonaBrowser
        except ImportError as exc:
            assert "daytona-toolsets[browser]" in str(exc), str(exc)
        else:
            raise AssertionError("expected DaytonaBrowser to need Playwright")
        print("OK")
        """)
    assert done.returncode == 0, done.stderr
    assert "OK" in done.stdout


def test_the_browser_driver_is_importable_by_name_with_the_extra() -> None:
    """With Playwright installed — as the dev extra has it — the name resolves through
    `__getattr__` exactly as before."""
    from daytona_toolsets import DaytonaBrowser

    assert DaytonaBrowser.__name__ == "DaytonaBrowser"
