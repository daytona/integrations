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

Demonstrates passing `sandboxId` between operations using `={{ $('Create Sandbox').item.json.id }}` expressions, and cleanup via Sandbox.Delete on the success path. For production, also route failures into a Sandbox.Delete (e.g. via an error branch) so a mid-workflow error doesn't leak the sandbox.

### `web-app-with-preview.json`

Run a long-lived web service in a sandbox and return a public URL.

```
Manual Trigger → Sandbox.Create → Code.RunCommand (start server) → Sandbox.GetPreviewUrl
```

The sandbox is configured with `public: true` and `autoStopInterval: 30`, so it auto-stops after 30 minutes **of inactivity** (the preview URL stops working once it does). The Get Preview URL node returns a signed URL with the auth token embedded — share it directly without needing custom headers. Auto-stop doesn't delete the sandbox, so add a Sandbox.Delete node when you're done to free resources.
