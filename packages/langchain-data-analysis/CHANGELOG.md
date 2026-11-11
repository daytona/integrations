# Changelog

## [0.2.2](https://github.com/daytona/integrations/compare/langchain-daytona-data-analysis-v0.2.1...langchain-daytona-data-analysis-v0.2.2) (2026-11-11)


### Documentation

* **langchain-data-analysis:** note the 0.2.1 breaking change for direct invoke() calls ([#106](https://github.com/daytona/integrations/issues/106)) ([0e54c1e](https://github.com/daytona/integrations/commit/0e54c1e20bbe2032cf2fe79b0a7bdb9fff84d787))

## [0.2.1](https://github.com/daytona/integrations/compare/langchain-daytona-data-analysis-v0.2.0...langchain-daytona-data-analysis-v0.2.1) (2026-11-02)


### ⚠ Breaking change for direct `invoke()` calls

Calling `tool.invoke({...})` without a ToolCall now returns the text the model sees instead of an `ExecutionArtifacts` object: the code's printed output, capped at `max_output_chars` (default 20,000), plus a one-line summary per chart. Agents need no changes, and `on_result` still receives the full `ExecutionArtifacts`.

If your code reads `.stdout` or `.charts` from the return value of `invoke()`, use `on_result` instead, or invoke with a ToolCall and read its artifact:

```python
message = tool.invoke({"args": {"data_analysis_python_code": code}, "id": "1", "name": tool.name, "type": "tool_call"})
message.artifact.stdout, message.artifact.charts
```

If you subclassed the tool to keep chart data out of the model's context (the workaround in [#81](https://github.com/daytona/integrations/issues/81)), remove the subclass. 0.2.1 does this itself, and the workaround now raises `ValueError` because `_run` has to return a `(content, artifacts)` pair.

### Bug Fixes

* **langchain-data-analysis:** don't print a trailing expression that evaluates to None ([#100](https://github.com/daytona/integrations/issues/100)) ([b31cb0b](https://github.com/daytona/integrations/commit/b31cb0be8f49a19fbaf13a2e73ee6cc8438ad799))
* **langchain-data-analysis:** keep chart image data out of the tool result sent to the model ([#99](https://github.com/daytona/integrations/issues/99)) ([14cfd49](https://github.com/daytona/integrations/commit/14cfd4905458c6ab30886a0bbf7c2ea5384c8ba7))
* **langchain-data-analysis:** widen the daytona dependency to &gt;=0.194.0,&lt;1.0.0 ([#98](https://github.com/daytona/integrations/issues/98)) ([64c9400](https://github.com/daytona/integrations/commit/64c94005d4d235aca2f2cd10eb63174e93f18515))

## [0.2.0](https://github.com/daytona/integrations/compare/langchain-daytona-data-analysis-v0.1.1...langchain-daytona-data-analysis-v0.2.0) (2026-07-06)


### Features

* **langchain-data-analysis:** address Cubic PR [#5](https://github.com/daytona/integrations/issues/5) review findings ([#19](https://github.com/daytona/integrations/issues/19)) ([db4b989](https://github.com/daytona/integrations/commit/db4b989194bbbd9a66346b5b8157bc9f660905d5))
