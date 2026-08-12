"""Unit tests for output truncation and file-window rendering."""

import pytest
from pydantic_ai.exceptions import ModelRetry

from pydantic_ai_daytona._tool_output import (
    format_size,
    guard_read_size,
    render_file_window,
    truncate,
    truncate_output,
)


class TestFormatSize:
    def test_bytes(self) -> None:
        assert format_size(512) == "512B"

    def test_kilobytes(self) -> None:
        assert format_size(51200) == "50.0KB"

    def test_megabytes(self) -> None:
        assert format_size(5 * 1024 * 1024) == "5.0MB"


class TestGuardReadSize:
    def test_within_limit_passes(self) -> None:
        guard_read_size(100, max_bytes=100)

    def test_over_limit_raises_model_retry(self) -> None:
        with pytest.raises(ModelRetry, match="over the .* read limit"):
            guard_read_size(101, max_bytes=100)


class TestTruncate:
    def test_no_truncation(self) -> None:
        result = truncate(["a", "b"], max_lines=10, max_bytes=100)
        assert result.kept_lines == ["a", "b"]
        assert not result.truncated

    def test_line_cap(self) -> None:
        result = truncate(["a", "b", "c"], max_lines=2, max_bytes=100)
        assert result.kept_lines == ["a", "b"]
        assert result.truncated_by == "lines"

    def test_byte_cap_never_emits_partial_line(self) -> None:
        result = truncate(["aaaa", "bbbb"], max_lines=10, max_bytes=6)
        assert result.kept_lines == ["aaaa"]
        assert result.truncated_by == "bytes"

    def test_tail_keeps_last_lines(self) -> None:
        result = truncate(["a", "b", "c"], max_lines=2, max_bytes=100, direction="tail")
        assert result.kept_lines == ["b", "c"]

    def test_tail_oversized_line_keeps_byte_suffix(self) -> None:
        result = truncate(["x" * 100], max_lines=10, max_bytes=10, direction="tail")
        assert result.kept_lines == ["x" * 10]
        assert result.truncated_by == "bytes"

    def test_head_oversized_first_line_is_omitted(self) -> None:
        result = truncate(["x" * 100], max_lines=10, max_bytes=10, direction="head")
        assert result.kept_lines == []
        assert result.first_line_exceeded

    def test_multibyte_boundary_not_split(self) -> None:
        result = truncate(["é" * 100], max_lines=10, max_bytes=9, direction="tail")
        assert all(len(line.encode()) <= 9 for line in result.kept_lines)
        assert "\ufffd" not in "".join(result.kept_lines)


class TestTruncateOutput:
    def test_passthrough_when_within_caps(self) -> None:
        assert truncate_output("hello\nworld") == "hello\nworld"

    def test_trailing_newline_not_counted_as_line(self) -> None:
        assert truncate_output("only\n", max_lines=1) == "only"

    def test_tail_marker_prepended(self) -> None:
        out = truncate_output("a\nb\nc", max_lines=2)
        assert out == "[... output truncated to the last 2 lines ...]\nb\nc"

    def test_head_marker_appended(self) -> None:
        out = truncate_output("a\nb\nc", max_lines=2, direction="head")
        assert out == "a\nb\n[... output truncated to the first 2 lines ...]"

    def test_byte_cap_named_in_marker(self) -> None:
        out = truncate_output("aaaa\nbbbb\ncccc", max_bytes=9)
        assert "9B" in out

    def test_oversized_single_line_head_omitted(self) -> None:
        out = truncate_output("x" * 100, max_bytes=10, direction="head")
        assert out == "[... first line exceeds the 10B limit, output omitted ...]"


class TestRenderFileWindow:
    def test_whole_file(self) -> None:
        assert render_file_window(b"a\nb\nc\n") == "a\nb\nc"

    def test_offset_and_limit(self) -> None:
        out = render_file_window(b"1\n2\n3\n4\n5\n", offset=2, limit=2)
        assert out.startswith("2\n3")
        assert "Use offset=4 to continue" in out

    def test_limit_to_end_has_no_note(self) -> None:
        assert render_file_window(b"1\n2\n", offset=2, limit=5) == "2"

    def test_safety_cap_reports_next_offset(self) -> None:
        data = "\n".join(str(i) for i in range(1, 11)).encode()
        out = render_file_window(data, max_lines=3)
        assert "[Showing lines 1-3 of 10" in out
        assert "Use offset=4 to continue" in out

    def test_offset_beyond_eof_raises(self) -> None:
        with pytest.raises(ModelRetry, match="beyond end of file"):
            render_file_window(b"a\n", offset=5)

    def test_invalid_offset_raises(self) -> None:
        with pytest.raises(ModelRetry, match="offset must be >= 1"):
            render_file_window(b"a\n", offset=0)

    def test_invalid_limit_raises(self) -> None:
        with pytest.raises(ModelRetry, match="limit must be >= 1"):
            render_file_window(b"a\n", limit=0)

    def test_binary_content_raises(self) -> None:
        with pytest.raises(ModelRetry, match="not valid UTF-8"):
            render_file_window(b"\xff\xfe\x00")

    def test_empty_file_is_one_empty_line(self) -> None:
        assert render_file_window(b"") == ""

    def test_oversized_line_omitted_with_continuation(self) -> None:
        data = ("x" * 100 + "\nshort\n").encode()
        out = render_file_window(data, max_bytes=10)
        assert "Line 1 is 100B" in out
        assert "Use offset=2 to continue" in out
