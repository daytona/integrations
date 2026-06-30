# AGENTS

This repo is a generated **generative-UI coding agent**: a CopilotKit chat where an
LLM (via OpenRouter) drives shell + filesystem tools inside a Daytona sandbox, and
every tool call renders as a live card (terminals, file diffs, an iframe preview).
Your job is to extend or rebrand it into a specific product without breaking the
working Daytona, OpenRouter, CopilotKit, and Vercel wiring that already exists.

## Start here

1. Read `prompts/starter-to-product.md`.
2. Inspect `app/api/copilotkit/route.ts` (the agent, its 11 tools, and the
   Daytona + OpenRouter wiring), `app/page.tsx` (one `useRenderTool` per tool),
   and `components/*Card.tsx` (the generative-UI cards).
3. If the product direction is not already clear, start with discovery questions
   before making large changes.
4. Restate what you intend to change and why before coding, and get the user's
   approval to proceed.

## Non-negotiables

- **Keep the OpenRouter call shape.** Use `createOpenAI({ apiKey, baseURL }).chat(model)`.
  Do **not** switch to the default `openrouter(model)` / `model: 'openai:...'` string —
  those target the OpenAI *Responses* API (`/responses`), which OpenRouter does not
  implement. `.chat()` targets `/chat/completions`, which it does.
- **Keep the credential bridges** in `route.ts`: `DAYTONA_API_KEY ?? DAYTONA_SANDBOX_API_KEY`
  (and `_API_URL`, `_ORGANIZATION_ID`), plus `OPENROUTER_*_API_KEY` discovery. They let
  the app run whether env came from `stripe projects env --pull` or raw keys.
- **Keep tools and their renderers in sync.** Every `defineTool` in `route.ts` has a
  matching `useRenderTool` in `app/page.tsx`. Add or remove both together.
- **Keep the route on the Node runtime** (`export const runtime = 'nodejs'`) — the
  Daytona SDK needs Node, not Edge — and keep `export const maxDuration` for Vercel.
- **Keep the sandbox ephemeral and bound to `0.0.0.0`** guidance in the system prompt
  so previews stay reachable through the Daytona proxy.
- Do not commit secrets. `.env` / `.env.local` are gitignored; `.env.example` documents
  the variables.

## What to customize first

- **Agent behavior & persona:** the `SYSTEM_PROMPT` and `maxSteps` in `route.ts`.
- **Model:** `OPENROUTER_MODEL` (any id from https://openrouter.ai/models).
- **Tools:** add a `defineTool` (Daytona SDK wrapper) + a matching `useRenderTool` card.
- **UI / branding:** the header and `CopilotChat` labels in `app/page.tsx`, the card
  styling in `components/`, and `app/globals.css`.

## Suggested phases

1. **Framing & UI:** rebrand the header, welcome message, and card styling; lock the
   look and feel. Remove starter/template messaging.
2. **Agent capabilities:** tune the system prompt, pick the model, add/remove tools for
   the specific workflow you want (e.g. data analysis, a specific framework scaffolder).
3. **Depth:** add persistence (e.g. Upstash Redis / Neon Postgres for chat history),
   auth, rate limiting, or multi-sandbox orchestration as the product requires.

## Discovery direction

- Ask one question at a time; don't dump a long questionnaire.
- Good topics: who the agent is for, the core workflow it should nail, the look and feel,
  which languages/frameworks it should be great at, and any must-haves or must-avoids.
- If the user is unsure, offer 2–4 concrete directions instead of guessing silently.
