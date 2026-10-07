# @daytona/claude-toolsets

[Daytona](https://www.daytona.io) sandbox drivers for the Anthropic SDK's **computer** and **browser** toolsets (`computer_toolset_20260801`, `browser_toolset_20260801`), for TypeScript. Hand one to the SDK's tool runner and Claude drives a desktop or a Chromium that runs in an isolated Daytona sandbox, while your API keys, the model loop and the toolset stay in your process.

> **Status: scaffolding.** The package skeleton, build and release wiring are in place; the `DaytonaComputer` and `DaytonaBrowser` drivers land in follow-up changes. For the Python equivalent that is already published, see [`daytona-claude-toolsets`](../daytona-claude-toolsets).

## Installation

```bash
npm install @daytona/claude-toolsets @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency — install it yourself so the toolset base classes come from the exact SDK version your application runs. Version `0.132.0` or newer is required (that is the first release exporting the toolset helpers from `@anthropic-ai/sdk/helpers/beta/toolsets`).

Set your keys in the environment:

```bash
export DAYTONA_API_KEY="..."    # https://app.daytona.io/dashboard/keys
export ANTHROPIC_API_KEY="..."
```

## Requirements

- Node.js 20 or newer (the package is ESM-only)
- A Daytona account and API key

## License

Apache-2.0 — see [LICENSE](LICENSE).
