# langchain-daytona-data-analysis

This package provides the `DaytonaDataAnalysisTool` - LangChain tool integration that enables agents to perform secure Python data analysis in a sandboxed environment. It supports multi-step workflows, file uploads/downloads, and custom result handling, making it ideal for automating data analysis tasks with LangChain agents.

## Installation

```bash
pip install -U langchain-daytona-data-analysis
```

Requires Python 3.10+. This release depends on the Daytona SDK 2.x `v0` namespace (`daytona[v0-sdk]`), pinned to the pre-release `2.0.0a5` until 2.0.0 is stable.

Self-hosted / custom API URL: SDK 2.x targets Daytona Cloud only. If you need a custom API URL (self-hosted Daytona), keep using a release of this package that is built on Daytona SDK 0.x.

You must configure credentials for Daytona. You can do this in one of three ways:

1. Set the `DAYTONA_API_KEY` environment variable:
	```bash
	export DAYTONA_API_KEY="your-daytona-api-key"
	```

2. Add it to a `.env` file in your project root:
	```env
	DAYTONA_API_KEY=your-daytona-api-key
	```

3. Pass the API key directly when instantiating `DaytonaDataAnalysisTool`:
	```python
	from langchain_daytona_data_analysis import DaytonaDataAnalysisTool

	tool = DaytonaDataAnalysisTool(daytona_api_key="your-daytona-api-key")
	```

## v2 PoC

This stacked branch runs the complete tool workflow on `daytona.v2` microVMs with
SDK `2.0.0a5`. The v0 examples below describe the parent branch, not this PoC.

**Breaking change:** `on_result` now receives `daytona.v2.InterpreterResult`, and
the result is also the artifact returned by `_run` / a `ToolMessage`. Read stdout
from `result.logs.stdout` and errors from `result.error` / `result.process`.
Charts are MIME-keyed `result.results[].data["image/png"]` (also `.png`), not
`Chart` objects: chart types/titles are unavailable. Model-facing content retains
bounded stdout and image MIME summaries; image payloads stay application-side.

```python
import base64

from daytona.v2 import InterpreterResult
from langchain_daytona_data_analysis import DaytonaDataAnalysisTool

def receive_result(result: InterpreterResult) -> None:
    print(result.logs.stdout)
    for output in result.results:
        if output.png:
            print("PNG bytes:", len(base64.b64decode(output.png)))

tool = DaytonaDataAnalysisTool(
    image="img_<your-registered-image-id>",
    on_result=receive_result,
)
try:
    tool.invoke({"data_analysis_python_code": "print('hello')"})
finally:
    tool.close()
```

`image: str | None = None` is a new optional constructor argument forwarded to
`v2.create`. It must name a registered v2 image (not a registry tag) unless the
organization has a platform default. The readiness organization has **no default
image**; its run used a registered image with Python 3.12, pandas, matplotlib and
numpy. Provide your own registered image with the packages your code needs.
Optional `create_kwargs` (e.g. `labels`, `lifecycle_policy`) are forwarded
unchanged to `v2.create`; by default only `image` is passed. No image build is
performed. The alpha.5 image
list/get/build-follow-up decoders have known `region_id` gaps in the reference
probe; this PoC bypasses them by creating directly from the retained image ID.

Uploads now go to the measured default user's home, `/root`, rather than
`/home/daytona`. `SandboxUploadedFile.remote_path` still identifies the actual
uploaded file, and `download_file` still returns bytes. The v2 filesystem uses
`write_bytes`, `read_bytes` and `delete`; package installation uses v2 `exec`.
Code runs remain isolated per invocation, with files shared across invocations.

As in v0, the tool sets no lifecycle policy or code/exec timeout of its own.
`close()` requests deletion, not synchronous destruction. The live check ran on
the previous PoC revision, which hard-coded a readiness label, a 600-second
auto-delete and 60-second bounds; the smoke now supplies its label and lifecycle
through `create_kwargs`. It passed stdout, actual PNG decoding, CSV upload/read/download/delete, package execution,
live `get_sandbox()`, missing-ID `NotFoundError`, deletion and a zero-leftover
label sweep. The anticipated live-get decoder gap did **not** occur. Differences
and measured evidence are recorded in the migration evidence `v2-ledger.md`;
no unsupported feature is stubbed.

## Instantiation

Import and instantiate the tool:

```python
from langchain_daytona_data_analysis import DaytonaDataAnalysisTool
from daytona.v0 import ExecutionArtifacts

 # Optionally, you can pass an on_result callback.
 # This callback lets you apply custom logic to the data analysis result.
 # For example, you can save outputs, display charts, or trigger other actions.
def process_data_analysis_result(result: ExecutionArtifacts):
	print(result)

tool = DaytonaDataAnalysisTool(
	# daytona_api_key="your-daytona-api-key",  # Only needed if DAYTONA_API_KEY is not set as an environment variable
	# max_output_chars=20_000,  # Cap on printed output returned to the model (beginning and end are kept)
	on_result=process_data_analysis_result
)
```

## Usage

The model only ever receives text: the code's printed output, plus a one-line summary of each generated chart (for example `- scatter: Price vs. mileage`). Chart image data stays out of the model's context; the full `ExecutionArtifacts`, PNG data included, are passed to `on_result` and attached to the returned `ToolMessage` as its `artifact`. Printed output longer than `max_output_chars` keeps its beginning and end.

`DaytonaDataAnalysisTool` can be used in three ways:


### Direct Invocation with Args

```python
tool.invoke({'data_analysis_python_code': "print('Hello World')"})
# 'Hello World'
```

### Invocation with ToolCall

```python
model_generated_tool_call = {
    "args": {'data_analysis_python_code': "print('Hello World')"},
    "id": "1",
    "name": tool.name,
    "type": "tool_call",
}

message = tool.invoke(model_generated_tool_call)
message.content   # 'Hello World'
message.artifact  # ExecutionArtifacts(stdout='Hello World\n', charts=[])
```

### Usage Inside an Agent

```python
from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic

model = ChatAnthropic(
    model_name="claude-haiku-4-5-20251001",
    temperature=0,
    max_tokens_to_sample=1024,
    timeout=None,
    max_retries=2,
    stop=None
)

agent = create_agent(model, tools=[tool])
```

## API Reference

The following public methods are available on `DaytonaDataAnalysisTool`:

### `download_file(remote_path)`
Downloads a file from the sandbox by its remote path.
- `remote_path`: `str` — Path to the file in the sandbox.
- **Returns:** `bytes` — File contents.

**Example:**
```python
# Download a file from the sandbox
file_bytes = tool.download_file("/home/daytona/results.csv")
```

---

### `upload_file(file, description)`
Uploads a file to the sandbox. The file is placed in `/home/daytona/`.
- `file`: `IO` — File-like object to upload.
- `description`: `str` — Description of the file, explaining its purpose and the type of data it contains.
- **Returns:** [`SandboxUploadedFile`](#sandboxuploadedfile) — Metadata about the uploaded file.

**Example:**
Suppose you want to analyze sales data for a retail business. You have a CSV file named `sales_q3_2025.csv` containing columns like `transaction_id`, `date`, `product`, `quantity`, and `revenue`. You want to upload this file and provide a description that gives context for the analysis.

```python
with open("sales_q3_2025.csv", "rb") as f:
    uploaded = tool.upload_file(
        f,
        "CSV file containing Q3 2025 retail sales transactions. Columns: transaction_id, date, product, quantity, revenue."
    )
```

---

### `remove_uploaded_file(uploaded_file)`
Removes a previously uploaded file from the sandbox.
- `uploaded_file`: [`SandboxUploadedFile`](#sandboxuploadedfile) — The file to remove.

**Example:**
```python
# Remove an uploaded file
tool.remove_uploaded_file(uploaded)
```

---

### `get_sandbox()`
Gets the current sandbox instance.
- **Returns:** [`Sandbox`](#sandbox) — Sandbox instance.

This method provides access to the Daytona sandbox instance, allowing you to inspect sandbox properties and metadata, as well as perform any sandbox-related operations. For details on available attributes and methods, see the [Sandbox](#sandbox) data structure section below.

**Example:**
```python
sandbox = tool.get_sandbox()
```

---

### `install_python_packages(package_names)`
Installs one or more Python packages in the sandbox using pip.
- `package_names`: `str` or `List[str]` — Name(s) of the package(s) to install.

> **Note:** The list of preinstalled packages in a sandbox can be found at [Daytona Default Snapshot documentation](https://www.daytona.io/docs/en/snapshots/#default-snapshot).

**Example:**
```python
# Install a single package
tool.install_python_packages("pandas")

# Install multiple packages
tool.install_python_packages(["numpy", "matplotlib"])
```

---

### `close()`
Closes and deletes the sandbox environment.

> **Note:** Call this method when you are finished with all data analysis tasks to properly clean up resources and avoid unnecessary usage.

**Example:**
```python
# Close the sandbox and clean up
tool.close()
```

---

## Data Structures

### SandboxUploadedFile
Represents metadata about a file uploaded to the sandbox.

- `name`: `str` — Name of the uploaded file in the sandbox
- `remote_path`: `str` — Full path to the file in the sandbox
- `description`: `str` — Description provided during upload

### Sandbox
Represents a Daytona sandbox instance.

See the full structure and API in the [Daytona Python SDK Sandbox documentation](https://www.daytona.io/docs/en/python-sdk/sync/sandbox/#sandbox).
