## Privacy Policy for Daytona Dify Plugin

This plugin connects to the Daytona API to create and manage sandbox environments. It defaults to the hosted Daytona endpoint (https://app.daytona.io/api); users on a self-hosted or region-specific Daytona deployment can point it at their own Daytona API URL through the plugin credentials.

### Data Collected

- **API Key**: Your Daytona API key is stored by Dify and sent to the Daytona API for authentication. It is never shared with third parties.
- **Code and Commands**: Code snippets and shell commands you submit are sent to the Daytona API for execution inside isolated sandboxes. Daytona does not use your code to train models or improve services.
- **File Contents**: Files and text you send to a sandbox (via the Upload File or Write File tools) are transmitted through the plugin to the Daytona API and stored inside the sandbox. Files and text you retrieve (via the Download File or Read File tools) are transferred from the sandbox through the plugin back into Dify. The plugin itself does not retain any file contents; storage is managed by Daytona for the lifetime of the sandbox.
- **Git Credentials**: When you clone a private repository via the Git Clone tool, any username and password/token you provide are sent through the plugin to the Daytona API to authenticate the clone. They are not retained or logged by the plugin and are redacted from the tool's output.
- **Sandbox Identifiers**: Sandbox IDs returned by the Daytona API are surfaced in Dify so subsequent tool calls can target the same sandbox.
- **Execution Output**: stdout, stderr, and exit codes from code and commands you run are returned by the Daytona API and surfaced in Dify.

### Data Storage

All sandbox data is processed and stored by Daytona in accordance with their [Privacy Policy](https://www.daytona.io/privacy-policy) and [Terms of Service](https://www.daytona.io/terms-of-service). Sandboxes and their data can be deleted at any time.

### Third-Party Services

This plugin communicates exclusively with the Daytona API. No data is sent to any other third-party service.

For questions about data handling, contact [support@daytona.io](mailto:support@daytona.io).
