# smolagents-daytona

Daytona sandbox code executor for [smolagents](https://github.com/huggingface/smolagents) `CodeAgent`s.

A smolagents `CodeAgent` writes its actions as Python code. Executing LLM-generated code is a
serious security concern, so it should run in a sandbox. This package runs each agent code step in
an isolated [Daytona](https://daytona.io) sandbox with a stateful interpreter context: variables,
imports, and tool definitions persist across steps, while your local environment stays untouched.

The executor is registered under the `smolagents.executors` entry-point group, so installing the
package is all the setup smolagents needs: `CodeAgent(executor_type="daytona")` resolves to it
automatically.

## Installation

```bash
pip install smolagents-daytona
```

Requires `smolagents>=1.27.0` (the release that introduced pluggable executors) and Python 3.10+.

## Quickstart

1. Create a Daytona account and generate an API key from the
   [Daytona Dashboard](https://app.daytona.io/dashboard/keys).
2. Set the `DAYTONA_API_KEY` environment variable.
3. Pass `executor_type="daytona"` when creating the agent:

```python
from smolagents import CodeAgent, InferenceClientModel

with CodeAgent(model=InferenceClientModel(), tools=[], executor_type="daytona") as agent:
    agent.run("Give me the 100th Fibonacci number.")
```

Using the agent as a context manager ensures the Daytona sandbox is released when the agent is
done; alternatively, call `agent.cleanup()` explicitly.

The agent's models are called from your local environment; only the generated code is sent to the
Daytona sandbox for execution, and only its output is returned.

## Customizing the sandbox

Everything in `executor_kwargs` is forwarded to
[`Daytona().create()`](https://www.daytona.io/docs/python-sdk/daytona/#daytonacreate):

```python
from daytona import CreateSandboxFromSnapshotParams
from smolagents import CodeAgent, InferenceClientModel

params = CreateSandboxFromSnapshotParams(
    name="my-agent-sandbox",
    env_vars={"DEBUG": "true"},
    auto_stop_interval=0,  # Disable auto-stop
)

with CodeAgent(
    model=InferenceClientModel(),
    tools=[],
    executor_type="daytona",
    executor_kwargs={"params": params, "timeout": 120},
) as agent:
    agent.run("Give me the 100th Fibonacci number.")
```

A custom Docker image works the same way with `CreateSandboxFromImageParams(image=...)`.

Additional packages required by the agent (beyond what its tools declare) can be preinstalled in
the sandbox through the agent's `additional_authorized_imports`; the executor installs them at
startup.

## Using the executor directly

The executor can also be constructed and driven without an agent:

```python
import io

from rich.console import Console
from smolagents import AgentLogger, LogLevel

from smolagents_daytona import DaytonaExecutor

executor = DaytonaExecutor(
    additional_imports=["numpy"],
    logger=AgentLogger(LogLevel.INFO, Console(file=io.StringIO())),
)
try:
    output = executor("import numpy as np; print(np.sqrt(2))")
    print(output.logs)
finally:
    executor.cleanup()
```

## Development

```bash
pip install -e ".[dev]"
pytest                            # offline unit tests (Daytona SDK mocked)
DAYTONA_API_KEY=... pytest tests/integration_tests   # live tests, real sandboxes
ruff check .
```

## License

Apache-2.0
