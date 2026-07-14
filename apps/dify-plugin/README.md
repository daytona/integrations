## Daytona

### Description

Dify plugin for [Daytona](https://www.daytona.io/), secure sandbox infrastructure for AI agents. Create isolated sandboxes, run code, execute shell commands, and manage their lifecycle directly from Dify workflows and agents.

### Features

- **Create Sandbox**. Provision an isolated sandbox from a Daytona snapshot or a custom Docker image, with optional resource limits, environment variables, and a chosen language runtime.
- **Run Code**. Execute a Python, TypeScript, or JavaScript snippet in a sandbox. For larger or multi-file scripts, upload them with **Upload File** and run them via **Run Command**.
- **Run Command**. Run a shell command in a sandbox and get back its combined output (stdout and stderr) and exit code, with optional working directory and environment variables.
- **Upload File**. Upload a file from Dify into a sandbox (e.g. a CSV to analyze, a script to run).
- **Download File**. Download a file from a sandbox back into Dify (e.g. a generated chart, processed data).
- **Get Preview URL**. Get the public URL that exposes a port from inside a sandbox so users can open a running web app, dashboard, or API in their browser.
- **Destroy Sandbox**. Stop and delete a sandbox when it is no longer needed.

### Setup

1. Create a [Daytona account](https://app.daytona.io/) if you don't have one.
2. Generate an API key from the [Daytona Dashboard](https://app.daytona.io/dashboard/keys).
3. Install this plugin in Dify and authorize it with your API key.

### Usage

#### Create and use a sandbox

Use **Create Sandbox** to provision a new environment. The contents of the sandbox depend on the snapshot or image you choose; if you provide neither, Daytona's default snapshot is used. The tool returns a `sandbox_id` you can pass to subsequent **Run Code** and **Run Command** calls to reuse the same environment.

#### Quick one-off execution

If you don't pass a `sandbox_id` to **Run Code** or **Run Command**, a temporary ephemeral sandbox is created automatically using the Daytona default snapshot, used for the execution, and destroyed afterward.

#### Cleanup

Use **Destroy Sandbox** to permanently delete a sandbox you provisioned with **Create Sandbox**. Ephemeral sandboxes created by **Run Code** and **Run Command** are cleaned up automatically.

### Tool Reference

| Tool | Inputs | Returns |
|------|--------|---------|
| `create_sandbox` | `name`, `snapshot`, `image`, `language`, `env_vars` (JSON string), `cpu`, `memory`, `disk`, `auto_stop_interval` (all optional) | `sandbox_id` |
| `run_code` | `code` (required), `language` (optional: `python`/`typescript`/`javascript`, default `python`, only used when creating an ephemeral sandbox), `sandbox_id` (optional, ephemeral if omitted) | `exit_code`, `output` (combined stdout+stderr), `sandbox_id`, `charts_count`, `charts` (list of `{type, title}`); any generated charts (e.g. matplotlib) are also emitted as PNG image blobs |
| `run_command` | `command` (required), `cwd` (optional), `env_vars` (JSON string, optional), `timeout` (optional, seconds; empty = Daytona default, `0` = no timeout), `sandbox_id` (optional, ephemeral if omitted) | `exit_code`, `output` (combined stdout+stderr), `sandbox_id` |
| `upload_file` | `sandbox_id`, `file` (Dify file picker), `remote_path` (all required) | `success`, `sandbox_id`, `remote_path`, `size_bytes` |
| `download_file` | `sandbox_id`, `remote_path` (both required) | File as Dify blob plus `success`, `sandbox_id`, `remote_path`, `size_bytes`, `mime_type`, `filename` |
| `get_preview_url` | `sandbox_id`, `port` (1–65535) (both required) | `url`, `token`, `port`, `sandbox_id`. URL persists while the sandbox runs. For private sandboxes, callers must send the token via the `x-daytona-preview-token` header. |
| `destroy_sandbox` | `sandbox_id` (required) | `success`, `sandbox_id` |

### Support

For questions, issues, or feedback about this plugin, contact [support@daytona.io](mailto:support@daytona.io).

### Links

- [Plugin Source Code](https://github.com/daytona/integrations/tree/main/apps/dify-plugin)
- [Daytona Documentation](https://www.daytona.io/docs)
- [Daytona Dashboard](https://app.daytona.io/)
