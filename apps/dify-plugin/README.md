## Daytona

### Description

Dify plugin for [Daytona](https://www.daytona.io/), secure sandbox infrastructure for AI agents. Create isolated sandboxes, run code and shell commands, manage files, clone Git repositories, run background services, and manage the full sandbox lifecycle directly from Dify workflows and agents.

### Features

- **Create Sandbox**. Provision an isolated sandbox from a Daytona snapshot or a custom Docker image, with optional resource limits, environment variables, and a chosen language runtime.
- **List Sandboxes**. List existing sandboxes with their IDs and states.
- **Manage Sandbox**. Start, stop, or archive an existing sandbox.
- **Destroy Sandbox**. Stop and delete a sandbox when it is no longer needed.
- **Run Code**. Execute a Python, TypeScript, or JavaScript snippet in a sandbox; any charts it generates (e.g. matplotlib) are returned as images.
- **Run Command**. Run a shell command in a sandbox and get back its combined output (stdout and stderr) and exit code, with optional working directory and environment variables.
- **Git Clone**. Clone a Git repository into a sandbox, with an optional branch or commit and credentials for private repositories.
- **Upload File**. Upload a file from Dify into a sandbox (e.g. a CSV to analyze, a script to run).
- **Download File**. Download a file from a sandbox back into Dify (e.g. a generated chart, processed data).
- **Read File**. Read a text file's contents from a sandbox.
- **Write File**. Write text content to a file in a sandbox.
- **List Files**. List the contents of a directory in a sandbox.
- **Search Files**. Find files by name pattern in a sandbox.
- **Find in Files**. Search file contents for a text pattern across a sandbox (like grep).
- **Start Service**. Start a long-running background process (web server, daemon) in a sandbox.
- **Get Service Logs**. Retrieve output from a background service started with **Start Service**.
- **Get Preview URL**. Get the public URL that exposes a port from inside a sandbox so users can open a running web app, dashboard, or API in their browser.

### Setup

1. Create a [Daytona account](https://app.daytona.io/) if you don't have one.
2. Generate an API key from the [Daytona Dashboard](https://app.daytona.io/dashboard/keys).
3. Install this plugin in Dify and authorize it with your API key.

### Usage

#### Create and use a sandbox

Use **Create Sandbox** to provision a new environment. The contents of the sandbox depend on the snapshot or image you choose; if you provide neither, Daytona's default snapshot is used. The tool returns a `sandbox_id` you can pass to subsequent **Run Code** and **Run Command** calls to reuse the same environment.

#### Quick one-off execution

If you don't pass a `sandbox_id` to **Run Code** or **Run Command**, a temporary ephemeral sandbox is created automatically using the Daytona default snapshot, used for the execution, and destroyed afterward.

#### Work with a Git repository

Use **Git Clone** to pull a repository into a sandbox, then **Run Command** or **Run Code** to build and run it. Private repositories can be cloned by supplying a username and a password/token.

#### Run and preview a web service

Use **Start Service** to launch a long-running server (bind it to `0.0.0.0` so it is reachable), **Get Preview URL** to obtain a public HTTPS URL for its port, and **Get Service Logs** to inspect its output.

#### Inspect and edit files

Use **List Files**, **Read File**, **Write File**, **Search Files**, and **Find in Files** to explore and modify a sandbox's filesystem, or **Upload File** / **Download File** to move files between Dify and the sandbox.

#### Manage sandboxes

Use **List Sandboxes** to see what exists, and **Manage Sandbox** to start, stop, or archive one (archiving preserves a stopped sandbox's filesystem in cold storage).

#### Cleanup

Use **Destroy Sandbox** to permanently delete a sandbox you provisioned with **Create Sandbox**. Ephemeral sandboxes created by **Run Code** and **Run Command** are cleaned up automatically.

### Tool Reference

| Tool | Inputs | Returns |
|------|--------|---------|
| `create_sandbox` | `name`, `snapshot`, `image`, `language`, `env_vars` (JSON string), `cpu`, `memory`, `disk`, `auto_stop_interval` (all optional) | `sandbox_id` |
| `list_sandboxes` | `limit` (optional, default 50) | `sandboxes` (list of `{id, name, state}`), `count` |
| `manage_sandbox` | `sandbox_id`, `action` (`start`/`stop`/`archive`) (both required) | `success`, `sandbox_id`, `action`, `state` |
| `destroy_sandbox` | `sandbox_id` (required) | `success`, `sandbox_id` |
| `run_code` | `code` (required), `language` (optional: `python`/`typescript`/`javascript`, default `python`, only used when creating an ephemeral sandbox), `sandbox_id` (optional, ephemeral if omitted) | `exit_code`, `output` (combined stdout+stderr), `sandbox_id`, `charts_count`, `charts` (list of `{type, title}`); any generated charts (e.g. matplotlib) are also emitted as PNG image blobs |
| `run_command` | `command` (required), `cwd` (optional), `env_vars` (JSON string, optional), `timeout` (optional, seconds; empty = Daytona default, `0` = no timeout), `sandbox_id` (optional, ephemeral if omitted) | `exit_code`, `output` (combined stdout+stderr), `sandbox_id` |
| `git_clone` | `sandbox_id`, `url`, `path` (all required), `branch`, `commit_id`, `username`, `password` (all optional) | `success`, `sandbox_id`, `url` (credentials redacted), `path`, `branch`, `commit_id` |
| `upload_file` | `sandbox_id`, `file` (Dify file picker), `remote_path` (all required) | `success`, `sandbox_id`, `remote_path`, `size_bytes` |
| `download_file` | `sandbox_id`, `remote_path` (both required) | File as Dify blob plus `success`, `sandbox_id`, `remote_path`, `size_bytes`, `mime_type`, `filename` |
| `read_file` | `sandbox_id`, `remote_path` (both required) | File contents as text plus `success`, `sandbox_id`, `remote_path`, `size_bytes` (max 100 MB) |
| `write_file` | `sandbox_id`, `remote_path`, `content` (all required) | `success`, `sandbox_id`, `remote_path`, `size_bytes` (max 100 MB) |
| `list_files` | `sandbox_id`, `path` (both required) | `entries` (list of `{name, size, is_dir, mode, owner}`), `count` |
| `search_files` | `sandbox_id`, `path`, `pattern` (all required) | `files` (matching file paths), `count` |
| `find_in_files` | `sandbox_id`, `path`, `pattern` (all required) | `matches` (list of `{file, line_number, line_content}`), `count` |
| `start_service` | `sandbox_id`, `command` (both required) | `session_id`, `cmd_id`, `sandbox_id`, `command` |
| `get_service_logs` | `sandbox_id`, `session_id` (required), `cmd_id` (optional) | Logs as text plus `session_id`, `cmd_id`, `sandbox_id`, `stdout`, `stderr` |
| `get_preview_url` | `sandbox_id`, `port` (1–65535) (both required) | `url`, `token`, `port`, `sandbox_id`. URL persists while the sandbox runs. For private sandboxes, callers must send the token via the `x-daytona-preview-token` header. |

### Support

For questions, issues, or feedback about this plugin, contact [support@daytona.io](mailto:support@daytona.io).

### Links

- [Plugin Source Code](https://github.com/daytona/integrations/tree/main/apps/dify-plugin)
- [Daytona Documentation](https://www.daytona.io/docs)
- [Daytona Dashboard](https://app.daytona.io/)
