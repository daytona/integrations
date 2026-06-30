Turn this generated app into a real product built on the Daytona Coding Agent starter.

Start by reading `AGENTS.md`, then follow this workflow:

1. Starter audit
   - Inspect `app/api/copilotkit/route.ts` (agent, 11 tools, Daytona + OpenRouter wiring),
     `app/page.tsx` (`useRenderTool` per tool), and `components/*Card.tsx` (the cards).
   - Note what must stay intact: the OpenRouter `.chat()` call shape, the
     `DAYTONA_*` / `OPENROUTER_*` credential bridges, the Node runtime + `maxDuration`
     exports, and the tool/renderer pairing.
   - Do not mistake the generic starter copy or layout for a real product brief.

2. Discovery-first conversation
   - If the user has not given a clear brief, do not jump straight into implementation.
   - Start grounded: "Tell me about the coding agent you want to build — who is it for,
     and what should it be great at?"
   - Ask one question at a time, then the next highest-value follow-up. Cover over time:
     - product name and audience
     - the core workflow (e.g. scaffold full apps, analyze data, fix bugs, teach)
     - which languages/frameworks/tools it should specialize in
     - desired look and feel, with a few concrete palette/style suggestions
     - guardrails: what the agent should never do
   - If the user is unsure, offer 2–4 concrete directions instead of inventing one.

3. Synthesis before coding
   - Summarize the brief back: confirmed name, audience, core workflow, and visual
     direction. Get explicit approval before implementing.

4. Implementation order
   - Framing & UI first: rebrand the header and `CopilotChat` labels in `app/page.tsx`,
     restyle the cards in `components/`, adjust `app/globals.css`. Remove starter messaging.
   - Agent behavior: tune `SYSTEM_PROMPT` and `maxSteps`; set `OPENROUTER_MODEL` to a
     model that fits the workflow.
   - Capabilities: add or remove tools. For each tool, add a `defineTool` in `route.ts`
     AND a matching `useRenderTool` card in `app/page.tsx`.
   - Depth (optional): chat-history persistence (Upstash Redis / Neon Postgres), auth,
     rate limiting, or multi-sandbox orchestration.

5. Verify
   - `npm run dev`, then send a prompt that exercises the core workflow end to end
     (sandbox creation → work → live preview).
   - `npm run build` stays green.
   - `npm run deploy` to ship to Vercel once the Vercel project env is pulled.

Constraints: keep the agent loop reliable (don't remove the sandbox-reuse / bind-to-0.0.0.0
guidance from the system prompt), and never hardcode secrets — read them from the
environment as the starter already does.
