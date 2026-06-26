## Privacy Policy for Daytona Dify Plugin

This plugin connects to the Daytona API (https://app.daytona.io/api) to create and manage sandbox environments.

### Data Collected

- **API Key**: Your Daytona API key is stored by Dify and sent to the Daytona API for authentication. It is never shared with third parties.
- **Code and Commands**: Code snippets and shell commands you submit are sent to the Daytona API for execution inside isolated sandboxes. Daytona does not use your code to train models or improve services.
- **File Contents**: Files you upload to a sandbox via the Upload File tool are transmitted through the plugin to the Daytona API and stored inside the sandbox. Files you retrieve via the Download File tool are transferred from the sandbox through the plugin back into Dify. The plugin itself does not retain any file contents; storage is managed by Daytona for the lifetime of the sandbox.
- **Sandbox Identifiers**: Sandbox IDs returned by the Daytona API are surfaced in Dify so subsequent tool calls can target the same sandbox.
- **Execution Output**: stdout, stderr, and exit codes from code and commands you run are returned by the Daytona API and surfaced in Dify.

### Data Storage

All sandbox data is processed and stored by Daytona in accordance with their [Privacy Policy](https://www.daytona.io/privacy-policy) and [Terms of Service](https://www.daytona.io/terms-of-service). Sandboxes and their data can be deleted at any time.

### Third-Party Services

This plugin communicates exclusively with the Daytona API. No data is sent to any other third-party service.

For questions about data handling, contact [support@daytona.io](mailto:support@daytona.io).
