"""Presentation helpers for sandbox file and command output.

Pure formatting is kept separate from the Daytona I/O layer so output behavior can be
tested without provisioning a sandbox. The output-shaping conventions (dual line/byte
caps, tail-first command output, head-first line-addressable file windows with
continuation offsets) follow the `pydantic-ai-harness` sandbox tools, so agents see
consistent behavior across sandbox capabilities.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic_ai.exceptions import ModelRetry

DEFAULT_MAX_LINES = 2000
DEFAULT_MAX_BYTES = 50 * 1024

TruncatedBy = Literal["lines", "bytes"] | None


@dataclass(kw_only=True, frozen=True)
class TruncationResult:
    """What fit under the caps, and which cap (if any) stopped the output."""

    kept_lines: list[str]
    truncated_by: TruncatedBy = None
    first_line_exceeded: bool = False

    @property
    def truncated(self) -> bool:
        return self.truncated_by is not None


def format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes}B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f}KB"
    return f"{num_bytes / (1024 * 1024):.1f}MB"


def _tail_bytes(line: str, max_bytes: int) -> str:
    return line.encode("utf-8")[-max_bytes:].decode("utf-8", errors="ignore")


def guard_read_size(size_bytes: int, *, max_bytes: int) -> None:
    """Refuse to read a file larger than `max_bytes`, pointing the model at shell tools.

    Raises:
        ModelRetry: if the file is too large, telling the model to read part of it instead.
    """
    if size_bytes > max_bytes:
        raise ModelRetry(
            f"File is {format_size(size_bytes)}, over the {format_size(max_bytes)} read limit. "
            "Read just the part you need with a shell command instead "
            "(e.g. head, tail, sed -n, or grep)."
        )


def truncate(
    lines: list[str],
    *,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
    direction: Literal["head", "tail"] = "head",
) -> TruncationResult:
    """Keep the lines that fit under both caps; never emit a partial line.

    `head` keeps the first lines (file reads), `tail` keeps the last (command output,
    where errors and the exit status live). A single line wider than the byte cap is
    kept as a byte-suffix in `tail` mode (the end carries the diagnostics) and omitted
    in `head` mode (an arbitrary prefix of one line is not useful for file reads).
    """
    if direction == "tail":
        lines = lines[::-1]

    if lines and len(lines[0].encode("utf-8")) > max_bytes:
        if direction == "tail":
            return TruncationResult(
                kept_lines=[_tail_bytes(lines[0], max_bytes)], truncated_by="bytes"
            )
        return TruncationResult(kept_lines=[], truncated_by="bytes", first_line_exceeded=True)

    kept: list[str] = []
    running_byte_size = 0
    truncated_by: TruncatedBy = None

    for line in lines:
        if len(kept) >= max_lines:
            truncated_by = "lines"
            break
        # +1 for the '\n' that '\n'.join inserts before every line except the first.
        cost = len(line.encode("utf-8")) + (1 if kept else 0)
        if running_byte_size + cost > max_bytes:
            truncated_by = "bytes"
            break
        kept.append(line)
        running_byte_size += cost

    if direction == "tail":
        kept = kept[::-1]
    return TruncationResult(kept_lines=kept, truncated_by=truncated_by)


def _split_lines(text: str) -> list[str]:
    # Split on '\n' only, not str.splitlines(): splitlines() also breaks on '\r', '\v',
    # '\f', and Unicode separators, which would make line numbers disagree with editors
    # and grep -n. A trailing newline yields a final '' element; drop it so the caps
    # count real lines and files report their true line count.
    lines = text.split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines = lines[:-1]
    return lines


def truncate_output(
    text: str,
    *,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
    direction: Literal["head", "tail"] = "tail",
) -> str:
    """Cap free-form tool output (e.g. shell) and mark it when anything was dropped.

    Unlike `render_file_window`, this output is not line-addressable, so the model gets
    a marker rather than a continuation offset. Defaults to `tail`: command errors and
    exit status live at the end.
    """
    result = truncate(_split_lines(text), max_lines=max_lines, max_bytes=max_bytes, direction=direction)
    if result.first_line_exceeded:
        return f"[... first line exceeds the {format_size(max_bytes)} limit, output omitted ...]"
    body = "\n".join(result.kept_lines)
    if not result.truncated:
        return body
    kept = "last" if direction == "tail" else "first"
    limit = f"{max_lines} lines" if result.truncated_by == "lines" else format_size(max_bytes)
    marker = f"[... output truncated to the {kept} {limit} ...]"
    return f"{marker}\n{body}" if direction == "tail" else f"{body}\n{marker}"


def render_file_window(
    data: bytes,
    *,
    offset: int | None = None,
    limit: int | None = None,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> str:
    """Decode, window, and truncate a file's bytes for a `read_file`-style tool.

    `offset`/`limit` are 1-indexed line counts (to agree with `grep -n`, editors, and
    stack traces). When the safety caps or `limit` stop the read short, the returned
    text ends with a note pointing at the next `offset` so the model can page the rest.

    Raises:
        ModelRetry: for bad bounds or non-UTF-8 content, so the model can react.
    """
    if offset is not None and offset < 1:
        raise ModelRetry(f"offset must be >= 1 (lines are 1-indexed), got {offset}")
    if limit is not None and limit < 1:
        raise ModelRetry(f"limit must be >= 1, got {limit}")

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ModelRetry("file is not valid UTF-8 text (it may be a binary file).")

    lines = _split_lines(text)
    total_lines = len(lines)

    start = offset - 1 if offset is not None else 0
    if start >= total_lines:
        raise ModelRetry(f"offset {offset} is beyond end of file ({total_lines} lines total)")

    end = min(start + limit, total_lines) if limit is not None else total_lines
    window = lines[start:end]

    result = truncate(window, max_lines=max_lines, max_bytes=max_bytes, direction="head")
    start_display = start + 1

    if result.first_line_exceeded:
        line_size = format_size(len(lines[start].encode("utf-8")))
        cont = f" Use offset={start_display + 1} to continue." if start + 1 < total_lines else ""
        return (
            f"[Line {start_display} is {line_size}, exceeds the {format_size(max_bytes)} "
            f"limit and was omitted.{cont}]"
        )

    body = "\n".join(result.kept_lines)

    if result.truncated:
        end_display = start_display + len(result.kept_lines) - 1
        next_offset = end_display + 1
        limit_note = f" ({format_size(max_bytes)} limit)" if result.truncated_by == "bytes" else ""
        return (
            f"{body}\n\n[Showing lines {start_display}-{end_display} of {total_lines}{limit_note}. "
            f"Use offset={next_offset} to continue.]"
        )

    if limit is not None and end < total_lines:
        remaining = total_lines - end
        return f"{body}\n\n[{remaining} more lines in file. Use offset={end + 1} to continue.]"

    return body
