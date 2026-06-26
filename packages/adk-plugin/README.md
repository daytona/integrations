# daytona-adk

Google ADK plugin for secure code execution in [Daytona](https://www.daytona.io) sandboxed environments. This plugin enables ADK agents to execute Python, JavaScript, and TypeScript code, run shell commands, upload scripts and datasets, and read outputs from files in isolated sandboxes.

## Installation

```bash
pip install daytona-adk
```

## Configuration

You must configure credentials for both Daytona (sandbox infrastructure) and Google Gemini (the LLM model used by ADK agents).

### Daytona API Key

Get your API key from [Daytona Dashboard](https://app.daytona.io/dashboard/keys).

You can configure it in one of three ways:

1. Set the `DAYTONA_API_KEY` environment variable:
    ```bash
    export DAYTONA_API_KEY="your-daytona-api-key"
    ```

2. Add it to a `.env` file in your project root:
    ```env
    DAYTONA_API_KEY=your-daytona-api-key
    ```

3. Pass the API key directly when instantiating `DaytonaPlugin`:
    ```python
    from daytona_adk import DaytonaPlugin

    plugin = DaytonaPlugin(api_key="your-daytona-api-key")
    ```

### Google API Key (for Gemini LLM)

Get your API key from [Google AI Studio](https://aistudio.google.com/apikey).

This key is required to access Google's Gemini models (e.g., `gemini-2.0-flash`, `gemini-1.5-pro`).

You need to set it as an environment variable:
```bash
export GOOGLE_API_KEY="your-google-api-key"
```

Or add it to your `.env` file:
```env
GOOGLE_API_KEY=your-google-api-key
```

## Quick Start

```python
import asyncio
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin


async def main():
    # Create the Daytona plugin
    plugin = DaytonaPlugin()

    # Create an agent with Daytona tools
    agent = Agent(
        model="gemini-2.0-flash",
        name="agent_with_sandbox",
        tools=plugin.get_tools(),
    )

    # Run with InMemoryRunner
    async with InMemoryRunner(
        app_name="my_app",
        agent=agent,
        plugins=[plugin],
    ) as runner:
        response = await runner.run_debug(
            "Execute this Python code: print('Hello from Daytona!')"
        )
        print(response)


if __name__ == "__main__":
    asyncio.run(main())
```

## Usage Patterns

### Using with App (Recommended)

```python
from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin

plugin = DaytonaPlugin()

agent = Agent(
    model="gemini-2.0-flash",
    name="agent_with_sandbox",
    tools=plugin.get_tools(),
)

app = App(
    name="my_app",
    root_agent=agent,
    plugins=[plugin],
)

async with InMemoryRunner(app=app) as runner:
    response = await runner.run_debug("Execute Python: print('Hello!')")
```

### Using with Runner Directly

```python
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin

plugin = DaytonaPlugin()

agent = Agent(
    model="gemini-2.0-flash",
    name="agent_with_sandbox",
    tools=plugin.get_tools(),
)

async with InMemoryRunner(
    app_name="my_app",
    agent=agent,
    plugins=[plugin],
) as runner:
    response = await runner.run_debug("Run command: echo 'Hello!'")
```

## Available Tools

The plugin provides the following tools to ADK agents:

| Tool | Description |
|------|-------------|
| `execute_code_in_daytona` | Execute Python, JavaScript, or TypeScript code |
| `execute_command_in_daytona` | Run shell commands |
| `upload_file_to_daytona` | Upload scripts or data files to the sandbox |
| `read_file_from_daytona` | Read script outputs or generated files |
| `start_long_running_command_daytona` | Start background processes (servers, watchers) |

### Tool Parameters

#### execute_code_in_daytona
- `code` (required): The code snippet to execute
- `language` (required): Programming language - `python` (default), `javascript`, or `typescript`
- `env`: Environment variables as key-value pairs
- `argv`: Command line arguments
- `timeout`: Timeout in seconds

#### execute_command_in_daytona
- `command` (required): The shell command to execute
- `cwd`: Working directory
- `env`: Environment variables
- `timeout`: Timeout in seconds

#### upload_file_to_daytona
- `file_path` (required): Destination path for the file
- `content` (required): File content to upload

#### read_file_from_daytona
- `file_path` (required): Path of the file to read

#### start_long_running_command_daytona
- `command` (required): The command to start
- `timeout`: Timeout in seconds

## Plugin Configuration

```python
DaytonaPlugin(
    api_key="your-api-key",           # Daytona API key (or use DAYTONA_API_KEY env var)
    plugin_name="daytona_plugin",     # Plugin identifier
    sandbox_name="my-sandbox",        # Optional sandbox name
    env_vars={"KEY": "value"},        # Environment variables for the sandbox
    labels={"env": "dev"},            # Custom labels
    auto_stop_interval=15,            # Auto-stop after N minutes (0 to disable)
    auto_delete_interval=60,          # Auto-delete stopped sandbox after N minutes
)
```

## Examples

See the [examples/](examples/) directory for complete working examples:

**Usage Patterns:**
- [`patterns/with_app.py`](examples/patterns/with_app.py) - Using DaytonaPlugin with the App pattern (recommended)
- [`patterns/with_runner.py`](examples/patterns/with_runner.py) - Using DaytonaPlugin with Runner directly

**Specific Use Cases:**
- [`multi_language_execution.py`](examples/multi_language_execution.py) - Execute Python, JavaScript, and TypeScript code
- [`file_operations.py`](examples/file_operations.py) - Upload scripts, execute them, and read output files
- [`long_running_process.py`](examples/long_running_process.py) - Start and manage background processes

## Architecture

```
packages/adk-plugin/
├── daytona_adk/
│   ├── __init__.py           # Package exports
│   ├── plugin.py             # DaytonaPlugin (extends BasePlugin)
│   └── tools.py              # ADK tool implementations
├── examples/
│   ├── patterns/
│   │   ├── with_app.py       # App pattern example
│   │   └── with_runner.py    # Runner pattern example
│   ├── multi_language_execution.py  # Multi-language code execution
│   ├── file_operations.py           # Script upload and file reading
│   └── long_running_process.py      # Background process management
├── tests/
│   └── test_tools.py         # Tool unit tests
└── pyproject.toml
```

### Key Components

1. **DaytonaPlugin**: Extends `BasePlugin`
   - Creates and manages sandbox lifecycle
   - Provides tools via `get_tools()`
   - Implements lifecycle callbacks

2. **Tools**: ADK tool implementations using `BaseTool`
   - Each tool wraps Daytona SDK operations
   - Shared sandbox instance for state persistence

## License

Apache 2.0 - See [LICENSE](LICENSE) file for details.

## References

- [Daytona Documentation](https://www.daytona.io/docs)
- [Google ADK Documentation](https://google.github.io/adk-docs/)
