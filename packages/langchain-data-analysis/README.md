# langchain-daytona-data-analysis

This package provides the `DaytonaDataAnalysisTool` - LangChain tool integration that enables agents to perform secure Python data analysis in a sandboxed environment. It supports multi-step workflows, file uploads/downloads, and custom result handling, making it ideal for automating data analysis tasks with LangChain agents.

## Installation

```bash
pip install -U langchain-daytona-data-analysis
```

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

## Instantiation

Import and instantiate the tool:

```python
from langchain_daytona_data_analysis import DaytonaDataAnalysisTool
from daytona import ExecutionArtifacts

 # Optionally, you can pass an on_result callback.
 # This callback lets you apply custom logic to the data analysis result.
 # For example, you can save outputs, display charts, or trigger other actions.
def process_data_analysis_result(result: ExecutionArtifacts):
	print(result)

tool = DaytonaDataAnalysisTool(
	daytona_api_key="your-daytona-api-key", # Only pass if not set as DAYTONA_API_KEY environment variable
	on_result=process_data_analysis_result
)
```

## Usage

`DaytonaDataAnalysisTool` can be used in three ways:


### Direct Invocation with Args

```python
tool.invoke({'data_analysis_python_code': "print('Hello World')"})
```

### Invocation with ToolCall

```python
model_generated_tool_call = {
    "args": {'data_analysis_python_code': "print('Hello World')"},
    "id": "1",
    "name": tool.name,
    "type": "tool_call",
}

tool.invoke(model_generated_tool_call)
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
