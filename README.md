# Daytona Integrations

Community and partner integrations, plugins, and tools for [Daytona](https://www.daytona.io). Each package in this monorepo is **versioned, released, and published independently**.

## Packages

Packages published to **a package registry** live in [`packages/`](packages/):

| Package | Published as |
|---|---|
| [`adk-plugin`](packages/adk-plugin) — Google ADK plugin | PyPI · [`daytona-adk`](https://pypi.org/project/daytona-adk/) |
| [`langchain-data-analysis`](packages/langchain-data-analysis) — LangChain data-analysis tool | PyPI · [`langchain-daytona-data-analysis`](https://pypi.org/project/langchain-daytona-data-analysis/) |
| [`n8n-nodes-daytona`](packages/n8n-nodes-daytona) — n8n community node | npm · [`@daytona/n8n-nodes-daytona`](https://www.npmjs.com/package/@daytona/n8n-nodes-daytona) |
| [`pi-extension`](packages/pi-extension) — Pi coding-agent extension | npm · [`@daytona/pi`](https://www.npmjs.com/package/@daytona/pi) |
| [`opencode-plugin`](packages/opencode-plugin) — OpenCode plugin | npm · [`@daytona/opencode`](https://www.npmjs.com/package/@daytona/opencode) |

## Apps

Standalone projects **not published to a package registry** live in [`apps/`](apps/):

| App | Description |
|---|---|
| [`inngest-agentkit-coding-agent`](apps/inngest-agentkit-coding-agent) | Deployable coding agent that runs tool calls in Daytona sandboxes |
| [`dify-plugin`](apps/dify-plugin) | Daytona plugin for the Dify marketplace |
| [`stripe-coding-agent-template`](apps/stripe-coding-agent-template) | Stripe Projects build template — a CopilotKit + OpenRouter coding agent, deployed on Vercel, that writes and runs code in Daytona sandboxes with live in-chat preview |

## Releases

Versioning is **per package**, automated with [release-please](https://github.com/googleapis/release-please):

- Merging PRs to `main` keeps a rolling **Release PR** per affected package up to date.
- Merging a package's Release PR tags it (`<component>-vX.Y.Z`), publishes a GitHub Release, and publishes to npm/PyPI via OIDC (with provenance) — no manual publish step.

## Contributing

- PRs are **squash-merged**, so the **PR title must be a [Conventional Commit](https://www.conventionalcommits.org/)** — e.g. `feat(pi-extension): add X`, `fix(adk-plugin): handle Y`. `feat` → minor, `fix` → patch, `feat!` / `BREAKING CHANGE:` → major; `chore`/`docs`/`ci` → no release.
- Keep each PR scoped to **one package** — release routing is by changed file path, not the scope text.
- Each package is self-contained (its own lockfile and dependencies); develop within its folder.

## License

[Apache-2.0](LICENSE), unless a package declares otherwise — each package includes its own `LICENSE`.
