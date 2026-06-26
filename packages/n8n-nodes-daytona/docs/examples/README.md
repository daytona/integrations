# Example workflows

Three importable n8n workflow JSONs demonstrating common Daytona node patterns.

## How to import

In n8n: **Workflows → Import from File** → select the JSON. After import, click each Daytona node and re-pick your credential (n8n needs you to select your actual credential from the dropdown; the workflow's saved credential ID won't match yours).

## Workflows

### `run-python-ephemeral.json`

The simplest possible code-execution workflow. AI agents and ad-hoc analysis use this pattern.

```
Manual Trigger → Daytona.RunCode (ephemeral, python)
```

A single Daytona node creates a temporary sandbox, runs Python, and auto-deletes the sandbox afterward. ~10 seconds end-to-end.

### `clone-build-download.json`

CI-style flow against a persistent sandbox.

```
Manual Trigger → Sandbox.Create → Git.Clone → Code.RunCommand (build) → File.Download → Sandbox.Delete
```

Demonstrates passing `sandboxId` between operations using `={{ $('Create Sandbox').item.json.id }}` expressions, and proper cleanup via Sandbox.Delete.

### `web-app-with-preview.json`

Run a long-lived web service in a sandbox and return a public URL.

```
Manual Trigger → Sandbox.Create → Code.RunCommand (start server) → Sandbox.GetPreviewUrl
```

The sandbox is configured with `public: true` and `autoStopInterval: 30` so the URL is browsable for up to 30 minutes of activity. The Get Preview URL node returns a signed URL with the auth token embedded — share it directly without needing custom headers.
