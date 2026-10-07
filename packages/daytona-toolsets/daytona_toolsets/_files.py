"""`DaytonaFilePolicy`: which sandbox paths `DaytonaBrowser` may upload from, and whether the
model is told where a download was saved.

Separate from `browser.py` because none of it touches the driver's live browser state, and
because importing it must not pull in Playwright: a caller can build the policy before deciding
to install the `browser` extra.
"""

from __future__ import annotations

import posixpath
from collections.abc import Sequence
from typing import Optional

from anthropic.tools.browser import BetaURLContext, UploadRefusedError


def is_under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


class DaytonaFilePolicy:
    """A `BetaFilePolicy` for a browser in a Daytona sandbox: upload paths are paths inside the
    sandbox, and so is the download directory.

    `BetaLocalFilePolicy` judges paths on the machine running the SDK, which is not where this
    browser reads files, so `DaytonaBrowser` refuses it. This policy admits an upload path only when
    it is absolute and lies under one of `upload_roots` (whole components, `..` refused). The driver
    then resolves each admitted path inside the sandbox, symlinks followed, and checks it again
    against the roots before the browser sees it.

    Args:
        upload_roots: Directories in the sandbox that `file_upload` may read from. Keep this to one
            dedicated directory holding only the task's files. Empty: path uploads are refused.
        download_dir: The sandbox directory downloads are saved to (created `0700`). Outside every
            upload root. Default: a fresh directory under `/tmp` per browser, which the driver
            binds into its own copy of this policy (`for_download_dir`), so
            `expose_download_paths` works without naming a directory.
        expose_download_paths: Show the model where a completed download was saved.
    """

    def __init__(
        self,
        *,
        upload_roots: Sequence[str] = (),
        download_dir: Optional[str] = None,
        expose_download_paths: bool = False,
    ) -> None:
        if isinstance(upload_roots, str):
            raise TypeError("upload_roots is a sequence of directories, not one path")
        roots = [self._absolute(root, "upload root") for root in upload_roots]
        if any(root == "/" for root in roots):
            raise ValueError("an upload root cannot be the filesystem root")
        self.upload_roots: tuple[str, ...] = tuple(roots)
        self.download_dir = (
            None if download_dir is None else self._absolute(download_dir, "download_dir")
        )
        if self.download_dir is not None and any(
            is_under(self.download_dir, root) or is_under(root, self.download_dir) for root in roots
        ):
            raise ValueError("download_dir must be outside every upload root")
        self.expose_download_paths = expose_download_paths

    @staticmethod
    def _absolute(path: str, what: str) -> str:
        if not path or not path.startswith("/"):
            raise ValueError(f"{what} must be an absolute path in the sandbox")
        return posixpath.normpath(path)

    def for_download_dir(self, download_dir: str) -> "DaytonaFilePolicy":
        """This policy, bound to the directory a browser actually saves downloads to.

        A policy that names no `download_dir` means "wherever the browser puts them", and only the
        driver knows that: unbound, `is_path_visible` could never say `True` and
        `expose_download_paths=True` would silently show nothing. The driver binds a copy at
        construction rather than mutating this one, so one policy can be shared between browsers
        and each still exposes its own directory. A policy that named a directory is returned
        unchanged.
        """
        if self.download_dir is not None:
            return self
        return DaytonaFilePolicy(
            upload_roots=self.upload_roots,
            download_dir=download_dir,
            expose_download_paths=self.expose_download_paths,
        )

    def resolve_upload_paths(self, context: BetaURLContext, paths: Sequence[str]) -> list[str]:
        if not self.upload_roots:
            raise UploadRefusedError("File uploads by path are not enabled for this browser.")
        resolved = []
        for path in paths:
            if not path.startswith("/") or ".." in path.split("/"):
                raise UploadRefusedError(
                    "An upload path must be an absolute path in the upload directory."
                )
            normal = posixpath.normpath(path)
            if not any(is_under(normal, root) for root in self.upload_roots):
                raise UploadRefusedError("An upload path is outside the upload directory.")
            resolved.append(normal)
        return resolved

    def resolve_upload_documents(
        self, context: BetaURLContext, document_ids: Sequence[str]
    ) -> list[str]:
        raise UploadRefusedError(
            "This browser runs in a Daytona sandbox and cannot upload Files API documents; put the "
            "file in the upload directory and upload it by path."
        )

    def is_path_visible(self, path: str) -> bool:
        return bool(
            self.expose_download_paths
            and self.download_dir is not None
            and is_under(posixpath.normpath(path), self.download_dir)
        )
