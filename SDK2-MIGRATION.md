# Daytona SDK 2.0 migration readiness

## 1. Validity

**Valid as of `@daytona/sdk@2.0.0-alpha.5` / `daytona==2.0.0a5` / `@daytona/upgrade@0.1.0` / `daytona-upgrade==0.1.0`; branches based on origin/main `14cfd49` (current origin/main is `ec6f147`, see §8b for the drift); facts captured 2026-11-02; PR daytona/rlp#3611 (draft) is the upgrade tool, not the v2 backend.**

Local toolchain: Node v22.23.2, npm 10.9.8, Python 3.12.3, uv 0.12.9, Poetry 2.4.2. CI uses Node `lts/*` and Python `3.12` (pydantic-ai, agentenv, langchain, claude-toolsets python) or `3.x` (adk). The dify-plugin venv ran on Python 3.14 through uv.

Every fact below is pinned to these alpha versions. The SDK says it may change between alphas, so re-check §10 before acting on a later alpha or on 2.0.0.

**Citation legend.** `(ref: sdk-ts:<path>:<line>)` is the file at `dist/cjs/<path>` inside the npm package `@daytona/sdk@2.0.0-alpha.5` (`package.json` is at the package root). `(ref: sdk-py:<path>:<line>)` is the file inside the wheel `daytona==2.0.0a5`, for example `daytona/v2/process.py`. `(ref: mapping:<line>)` is a line of https://unpkg.com/@daytona/upgrade@0.1.0/dist/mapping.json. `(ref: docs:<page>:<line>)` is a line of https://www.daytona.com/docs/<page>.md. `(ref: MIGRATION:<line>)` is a line of `clients/upgrade/MIGRATION.md` in daytona/rlp@253e8e2. Repo code is cited as `<repo path>:<line>` at the branch named in the same row or bullet. Facts marked "measured 2026-11-02" come from live runs against Daytona Cloud with the alpha SDKs. Raw evidence (codemod reports, logs, ledgers, smoke scripts) is kept in the maintainers' local readiness evidence store and is not part of this repository.

## 2. Executive answer: can we migrate without blockers?

**Step A (SDK 2.x on the `.v0` namespace): yes for all 12 SDK consumers, with the changes listed in §3.** Each has a pushed `feat/<component>-sdk2` branch with the official codemod applied, the exact alpha pinned, CI-parity commands matching their baseline (the one new failure is the agentenv upstream conflict below), and a live v0 smoke that created and deleted a real sandbox. One package is READY as-is (daytona-adk); eleven are READY-WITH-CHANGES. Four things keep the GA flip from being clean:

1. **agentenv-daytona has an upstream blocker.** agentenv-framework (>=0.9.1417, allowed by the package's `>=0.9.1322,<0.10`) ships a built-in `daytona` provider that shadows this plugin, imports SDK 0.x root names (`CreateSandboxFromImageParams`, `CreateSandboxFromSnapshotParams`, `Resources`) and pins `daytona~=0.224.0` in its `daytona` extra. Under SDK 2.x those imports raise ImportError, so `build_sandbox_provider('daytona')` fails for every user and `agentenv-framework[daytona]` can't be installed next to this package. The fix has to ship in agentenv-framework (drop or defer the built-in, or migrate it to `daytona.v0` and widen its extra).
2. **Self-hosted users are excluded.** SDK 2.x is Daytona-Cloud-only. Four packages lose their custom URL/target option (stripe, agentenv, dify, pydantic-ai) and every self-hosted user must stay on the 0.x releases (§4).
3. **Breaking floors.** Node `>=22.4.0` for the six TypeScript consumers (claude-toolsets, pi-extension, opencode-plugin, opencode-workspaces-plugin, inngest, stripe) and Python `>=3.10` for langchain-daytona-data-analysis. These are `feat!` commits and drive the version bumps in §8d.
4. **Rebase at GA.** langchain must absorb #100 and #104; the other branches have no drift today (§8b).

**Step B (`.v2` on microVMs): not today.** Of 14 integrations, 0 are READY, 1 is READY-WITH-CHANGES (langchain-daytona-data-analysis, breaking callback type), and 13 are BLOCKED: 11 BLOCKED-BY-V2-GAP and 2 BLOCKED-BY-REWRITE (the REST-only convex and n8n). The dominant blockers:

- **Sessions rejected by the deployed daemon** (measured 2026-11-02): `process.create_session` / `createSession` fails with HTTP 422 `unknown variant session, expected one of exec, pty, code`. This blocks 3 of the 4 PoCs and every package that runs commands through sessions.
- **No persistent sandboxes**: v2 `create()` is ephemeral-only, so get/start/stop reattach flows (pydantic-ai, pi, opencode-plugin, opencode-workspaces, dify, claude-toolsets `onClose: stop`, convex/n8n start/stop) have no v2 path.
- **Computer-use parity**: no mouse/keyboard down/up, click count, mouse modifiers or horizontal scroll (both claude-toolsets packages).
- **SSH access**: `createSshAccess` has no v2 equivalent (opencode-plugin git sync).
- **Images**: no default image is configured (`DEFAULT_IMAGE_NOT_CONFIGURED`), so callers must pass a registered `img_` id; the images API decoders are broken in both SDKs on a missing `region_id`, and the Python list/search read path fails the same way.

| integration | Step A verdict | branch@sha | Step B verdict | blocking v2 gap(s) |
|---|---|---|---|---|
| daytona-adk | READY | `feat/daytona-adk-sdk2@4f928ea` | BLOCKED-BY-V2-GAP | sessions (create_session 422) |
| langchain-daytona-data-analysis | READY-WITH-CHANGES (Python >=3.10, exact pin) | `feat/langchain-daytona-data-analysis-sdk2@b3dfaa6` | READY-WITH-CHANGES (breaking) | `on_result` becomes `InterpreterResult`; registered image id required |
| pydantic-ai-daytona | READY-WITH-CHANGES (api_url/target removed) | `feat/pydantic-ai-daytona-sdk2@af0d42a` | BLOCKED-BY-V2-GAP | persistence (attach/start); sessions; Python `user=`; default image |
| agentenv-daytona | READY-WITH-CHANGES (api_url/target removed; upstream framework conflict) | `feat/agentenv-daytona-sdk2@438d154` | BLOCKED-BY-V2-GAP | image build decoder; DinD unverified; sessions; upstream provider |
| daytona-claude-toolsets | READY-WITH-CHANGES (test doubles routed to `.v0`) | `feat/daytona-claude-toolsets-sdk2@22de00f` | BLOCKED-BY-V2-GAP | computer-use parity; desktop image; sessions (Chromium) |
| claude-toolsets | READY-WITH-CHANGES (Node >=22.4.0; per-folder codemod) | `feat/claude-toolsets-sdk2@2169287` | BLOCKED-BY-V2-GAP | computer-use parity; signed preview; sessions; desktop image |
| convex | N/A (no SDK) | — (REST-only, no branch) | BLOCKED-BY-REWRITE | 23 CHANGED + 1 NO-V2-EQUIVALENT (volumes) |
| n8n-nodes-daytona | N/A (no SDK) | — (REST-only, no branch) | BLOCKED-BY-REWRITE | 29 CHANGED + 8 NO-V2-EQUIVALENT (volumes, snapshot activate) |
| pi-extension | READY-WITH-CHANGES (Node >=22.4.0; DAYTONA_API_URL dropped) | `feat/pi-extension-sdk2@9c2a066` | BLOCKED-BY-V2-GAP | persistence; list/search decoder; home dir; sandbox-wide public |
| opencode-plugin | READY-WITH-CHANGES (Node >=22.4.0) | `feat/opencode-plugin-sdk2@2fff766` | BLOCKED-BY-V2-GAP | SSH access; persistence; sessions (background bash) |
| dify-plugin | READY-WITH-CHANGES (api_url credential removed) | `feat/dify-plugin-sdk2@3e449f7` | BLOCKED-BY-V2-GAP | persistence (manage_sandbox); sessions; list decoder; default image |
| inngest-agentkit-coding-agent | READY-WITH-CHANGES (Node >=22.4.0; deep import replaced) | `feat/inngest-agentkit-coding-agent-sdk2@42eeb60` | BLOCKED-BY-V2-GAP | sessions (422); interpreter argv |
| opencode-workspaces-plugin | READY-WITH-CHANGES (Node >=22.4.0; 14 test FIXMEs fixed) | `feat/opencode-workspaces-plugin-sdk2@f9dc243` | BLOCKED-BY-V2-GAP | never-delete lifecycle; stop/start persistence; preview token |
| stripe-coding-agent-template | READY-WITH-CHANGES (apiUrl dropped; Node >=22.4.0) | `feat/stripe-coding-agent-template-sdk2@53b2350` | BLOCKED-BY-V2-GAP | sessions (422) |

The four PoC branches stacked on Step A are `feat/daytona-adk-sdk2-v2@76813ba`, `feat/langchain-daytona-data-analysis-sdk2-v2@230eccf`, `feat/inngest-agentkit-coding-agent-sdk2-v2@ae51d35` and `feat/stripe-coding-agent-template-sdk2-v2@c42ef43` (§5). No pull request exists for any branch.

## 3. Step A details per integration

Common to all twelve: the codemod rewrote root-client calls to `client.v0.*` and resource imports to `daytona.v0` / `@daytona/sdk/v0`, because the SDK 2 root client only has `.v0`, `.v2` and `close` (ref: sdk-ts:Daytona.d.ts:35) (ref: sdk-py:daytona/_client.py:353). The codemod writes `^2.0.0` / `>=2,<3`, which can't resolve while only pre-releases exist, so every branch pins the exact alpha by hand; a re-run of `--dry` after pinning only proposes widening that pin again. The v0 not-found error class is preserved: every smoke asserted `get("does-not-exist")` raises `DaytonaNotFoundError` from the v0 namespace (ref: sdk-ts:v0/errors/DaytonaError.js:324) (ref: sdk-py:daytona/v0/common/errors.py:337). Every commit is DCO-signed with the author email in `Signed-off-by`, and no branch touches `version`, `CHANGELOG.md` or `.release-please-manifest.json`. A follow-up docs commit on each branch states that the last self-hosted-capable release is the one built on Daytona SDK 0.x.

### daytona-adk

- Verdict: READY. Branch https://github.com/daytona/integrations/tree/feat/daytona-adk-sdk2 (`4f928ea`, 2 commits since base).
- Forced breaks: none beyond the SDK major. Pin `daytona[v0-sdk]==2.0.0a5` at `packages/adk-plugin/pyproject.toml:28` (was `>=0.194.0,<0.195.0`).
- Codemod: dry exit 0, dry `--json` exit 0, apply `--yes --json` exit 0; changed `plugin.py`, `tools.py`, `pyproject.toml`; applied diff equals dry diff; `--suggest-v2 --json` exit 0 and wrote nothing.
- FIXMEs: 0 inserted; 1 informational `types-unresolved` item ledgered.
- CI parity: ruff exit 0 before and after; pytest 22 collected / 22 skipped before and after (the suite is live-gated, so it proves imports only).
- Live v0 smoke: `execute_code` (`print(1+1)` -> `2`), `execute_command`, labelled create, NOTFOUND_OK, package-driven delete. Sandboxes 1 created / 1 deleted.

### langchain-daytona-data-analysis

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/langchain-daytona-data-analysis-sdk2 (`b3dfaa6`, 3 commits). Evidence: `packages/langchain-data-analysis/pyproject.toml:22` (`python = ">=3.10,<4.0"`) and `:24` (`daytona = {version = "2.0.0a5", extras = ["v0-sdk"]}`); the root client has no resource methods, so `create`/`get`/`delete` moved to `.v0` (ref: sdk-py:daytona/_client.py:353).
- Forced breaks: Python floor raised from `>=3.9` to `>=3.10` in its own `feat!` commit, because SDK 2 supports Python 3.10+ and Poetry couldn't resolve it under the old floor; exact pre-release pin (Poetry accepts the exact `2.0.0a5` without `allow-prereleases`, but rejects it under `>=2,<3`).
- Codemod: dry/apply exit 0; 3 FIXMEs inserted (`close()`, `get_sandbox()`) and resolved by moving the calls to `.v0`; 2 `mock-target` items resolved by moving the unit-test `Daytona` mocks under `.v0`; notebook diff applied by the tool.
- FIXMEs: 3 inserted / 3 resolved / 0 ledgered.
- CI parity: `poetry run ruff check .` clean both times; `pytest tests/unit_tests` 21 passed before and after. A mutation probe (reverting the mock to the root shape) turns 5 tests red, so the suite covers the `.v0` path. `poetry.lock` is gitignored in this package.
- Live v0 smoke: INVOKE_OK, NOTFOUND_OK. Sandboxes 1 / 1.
- Note: `tool.close()` deletes via `.v0` but doesn't call the root `Daytona.close()`; ledgered.

### pydantic-ai-daytona

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/pydantic-ai-daytona-sdk2 (`af0d42a`, 3 commits). Evidence: `packages/pydantic-ai-daytona/pyproject.toml:33` (exact pin; the "Wide on purpose" comment is kept with a note to restore `>=2,<3` at GA); the root config rejects `api_url` with a TypeError (ref: sdk-py:daytona/_client.py:202).
- Forced breaks: `api_url` and `target` options removed from the session, capability and toolset (`feat!`, commit #1). The session config was inlined so the codemod could verify it.
- Codemod: dry refused twice with exit 2 (`custom-api-url`), then exit 0 after commit #1; apply exit 0, 12 files, 13 manual items, 0 FIXMEs. One codemod miss fixed by hand: integration create-recorders at `tests/integration_tests/conftest.py:108-111,120` retargeted to the v0 client class.
- FIXMEs: 0; manual items 13 = 12 `mock-target` resolved (unit fakes gained a `FakeV0` facade) + 1 `types-unresolved` ledgered.
- CI parity: ruff 0; pytest 165 passed (baseline 165); mypy 0. `black --check` exits 1 before and after, but the failing file count went from 3 to 4 because the codemod wrote a 104-character import in `tests/unit_tests/conftest.py`; CI runs only ruff and pytest for this package, so it isn't a blocker. Reformat before GA.
- Live v0 smoke: SMOKE_OK, NOTFOUND_OK, DELETE_CONFIRMED. Sandboxes 1 / 1.

### agentenv-daytona

- Verdict: READY-WITH-CHANGES, with the upstream blocker from §2. Branch https://github.com/daytona/integrations/tree/feat/agentenv-daytona-sdk2 (`438d154`, 3 commits). Evidence: `packages/agentenv-daytona/pyproject.toml:31` (exact pin); root config has no URL field (ref: sdk-py:daytona/_client.py:156).
- Forced breaks: `api_url` / `target` config keys removed (`feat!`, commit #1). `CONFIG_KEYS` is now `api_key, snapshot, base_image, egress_hosts`; `DEFAULT_API_URL` survives only for the non-SDK preview-domain fetch.
- Codemod: dry/apply exit 0; 0 FIXMEs. The codemod missed 4 resource calls because the receivers are typed `Any`; they were hand-migrated to `.v0` in commit #2. Unit fakes gained a `FakeV0` facade.
- FIXMEs: 0 inserted; 1 `types-unresolved` ledgered; 21 `--suggest-v2` items fed into §6.
- CI parity: ruff 0 -> 0, black 0 -> 0, mypy 0 -> 0. pytest exit 1 -> 1, but 3 failed / 125 passed -> 4 failed / 126 passed. All four failures are in `test_registration.py`. Three pre-exist (the framework's built-in `daytona` provider already shadowed the plugin on 0.x); the fourth, `test_an_unknown_config_key_fails_the_build`, newly fails with an ImportError from the built-in provider under SDK 2. With the built-in removed from the registry, 130 tests pass. This is the upstream blocker, not a package defect.
- Live v0 smoke (direct `DaytonaSandboxProvider.from_config`): DOCKER_OK, TUNNEL_OK, NOTFOUND_OK, TERMINATED. Sandboxes 1 / 1. The cold host-image build path wasn't exercised (image was cached).

### daytona-claude-toolsets

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/daytona-claude-toolsets-sdk2 (`22de00f`, 2 commits). Evidence: `packages/claude-toolsets/python/pyproject.toml:41` (exact pin, was `>=0.223.0,<0.224.0`); v0 keeps `mouse.down/up` while v2 lacks them (ref: sdk-py:daytona/v2/computer_use_services.py:136).
- Forced breaks: none beyond the SDK major (`requires-python >=3.10` already matched).
- Codemod: dry, dry `--json`, apply exit 0 (11 files), post-apply dry idempotent; `--suggest-v2` 67 items (6 "No v2 equivalent" for mouse/key down/up).
- FIXMEs: 0 inserted. The codemod didn't route the bare `MagicMock` test doubles in `tests/unit_tests/{test_computer,test_browser,test_examples}.py`; 3 files fixed by hand (6 failures before the fix).
- CI parity: ruff, black, mypy, pytest exit 0 before and after; 237 passed both times. Mutation probes confirm the `.v0` path is covered.
- Live v0 smoke: SCREENSHOT_OK (PNG), integer cursor position, MOUSE_DOWN_UP_OK, NOTFOUND_OK. Sandboxes 1 / 1.

### claude-toolsets

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/claude-toolsets-sdk2 (`2169287`, 2 commits). Evidence: `packages/claude-toolsets/typescript/package.json:43` (`"node": ">=22.4.0"`) and `:57` (exact pin, was `^0.223.0`); the alpha's engine floor (ref: sdk-ts:package.json:167).
- Forced breaks: Node floor `>=22.4.0`; a test fixture's `apiUrl` removed because the root constructor throws on it (ref: sdk-ts:Daytona.js:173).
- Codemod: **tool defect**: `@daytona/upgrade@0.1.0` hangs on a whole-package scan (exit 124 at the 900 s cap, three times; a minimal repro throws `RangeError: Invalid array length` while analysing `vi.fn().mockResolvedValue`). It was applied per folder (`src/`, `examples/`). `tests/` was migrated by hand (the codemod refused on the fixture `apiUrl` literal) and confirmed by a zero-change dry run afterwards.
- FIXMEs: 1 inserted / 1 resolved / 0 remaining.
- CI parity: 15 files / 344 tests pass before and after; typecheck and build exit 0; V0_ESM_OK.
- Live v0 smoke: SCREENSHOT_OK, MOUSE_DOWN_UP_OK, NOTFOUND_OK. Sandboxes 1 / 1.
- Pre-existing: `src/chromium.ts` keeps a type-only import of `SessionExecuteRequest` from the undeclared transitive `@daytona/toolbox-api-client`, because v0 doesn't re-export it (ref: sdk-ts:v0/index.d.ts:1).

### pi-extension

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/pi-extension-sdk2 (`9c2a066`, 2 commits). Evidence: `packages/pi-extension/package.json:43` (exact pin, was `^0.184.0`) and `:46` (`"node": ">=22.4.0"`); the root `.v0` client ignores `DAYTONA_API_URL` (ref: sdk-ts:Daytona.js:275).
- Forced breaks: Node floor; `DAYTONA_API_URL` README row removed (the `DAYTONA_TARGET` row stays, see §4).
- Codemod: dry, dry `--json`, apply, `--suggest-v2`, post-apply dry all exit 0. Output depends on `npm ci` having run first (§8c).
- FIXMEs: 1 inserted (a false-positive `mock-target` at `index.ts:432`) / 1 removed; 4 manual items = 2 code changes (`scripts/recovery.mjs` now imports `DaytonaNotFoundError` from `@daytona/sdk/v0`) + 2 reviewed with no change.
- CI parity: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run smoke` 0/0/0 before and after. A negative probe proves any missed root call is a TS2339 compile error. `scripts/*.mjs` aren't typechecked.
- Live v0 smoke: SETLABELS_OK, SMOKE_CHECKS_OK 5/5, NOTFOUND_OK (status 404), DELETE_CONFIRMED. Sandboxes 1 / 1.

### opencode-plugin

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/opencode-plugin-sdk2 (`2fff766`, 2 commits). Evidence: `packages/opencode-plugin/package.json:32` (exact pin, was `^0.204.1`) and `:42` (Node floor) (ref: sdk-ts:package.json:167).
- Forced breaks: Node floor only.
- Codemod: rewrote the 7 dot-directory sources under `.opencode/plugin/daytona/**` itself; no manual v0 rewrite needed. The codemod emitted one cosmetic split import.
- FIXMEs: 0 / 0 / 0.
- CI parity: typecheck and build pass before and after (no tests exist).
- Live v0 smoke: run 1 failed on a smoke-script assertion (the bash tool returned `Exit code: 0\nok\n`, which is correct behaviour); run 2 passed: CREATE_OK, LABELS_OK, EXEC_OK, RECONNECT_OK (fresh manager, `v0.get` + `start`, same id), SSH_ACCESS_OK (token never printed), NOTFOUND_OK, DELETE_CONFIRMED. Sandboxes 2 / 2.

### dify-plugin

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/dify-plugin-sdk2 (`3e449f7`, 3 commits). Evidence: `apps/dify-plugin/pyproject.toml:15` and `apps/dify-plugin/requirements.txt:2` (exact pin, was `>=0.193.0,<1.0.0`); custom URL text "SDK 2.x targets Daytona Cloud" (ref: sdk-py:daytona/_client.py:73).
- Forced breaks: the user-facing `api_url` credential removed from `_client.py` and `provider/daytona.yaml` (`feat!`, commit #1); `PRIVACY.md` self-hosted sentence adjusted.
- Codemod: dry exit 2 (`custom-api-url`) before commit #1, exit 0 after; apply exit 0, 10 files; per-file mode not needed.
- FIXMEs: 0; 2 manual items (`private-import`, `types-unresolved`) ledgered as non-actionable.
- CI parity: the app isn't in `ci.yml`. `uv lock --check` exit 0; `uv run python -c 'import _client, provider.daytona'` exit 0. The literal `uv run ruff check .` / `uv run black --check -l 100 .` exit 2 before and after because **ruff and black aren't project dependencies** (pre-existing). Substitute `uvx` runs report the same 17 ruff findings and 17 black files at base and head. `uv lock` also bumped transitive packages (aiohttp, pydantic, urllib3). `requirements.txt` stays a two-line mirror of direct dependencies.
- Live v0 smoke (re-run after an in-script failure that created nothing): SMOKE_PASS 1/1, RUN_CODE_OK, NOTFOUND_OK, DELETE_CONFIRMED. Sandboxes 1 / 1.

### inngest-agentkit-coding-agent

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/inngest-agentkit-coding-agent-sdk2 (`42eeb60`, 3 commits). Evidence: `apps/inngest-agentkit-coding-agent/package.json:9` (Node floor) and `:21` (`@daytona/sdk` exact pin, was `@daytonaio/sdk ^0.117.0`); v0 exports `FileUpload` (ref: sdk-ts:v0/index.d.ts:4) and the package only exports `.`, `./v0`, `./v2` (ref: sdk-ts:package.json:29).
- Forced breaks: package rename to `@daytona/sdk`; Node `>=22.4.0`; Dockerfile `node:22-alpine`; the private deep import `@daytonaio/sdk/src/FileSystem.js` replaced by `@daytona/sdk/v0`.
- Codemod: dry, dry `--json`, apply, `--suggest-v2` (16 suggestions) exit 0; post-apply dry 0 files.
- FIXMEs: 0; 3 manual items (deep import fixed in code; `env-api-url` needs no change because `.env.example` has no `DAYTONA_API_URL`; exact pin intentional).
- CI parity (not in `ci.yml`): `npm ci` / `npm run build` 0/0 before and after; `docker build` exit 0. Restoring the deep import fails with TS2307, so the build gate is real.
- Live v0 smoke: LABEL_OK, NOTFOUND_OK, DELETE_CONFIRMED. Sandboxes 1 / 1.
- npm reports ERESOLVE peer warnings about `@opentelemetry/api` from the alpha's own tree. `@opentelemetry/api` is an optional peer and a regular dependency of the alpha, adding it doesn't clear the warnings, so it wasn't added.

### opencode-workspaces-plugin

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/opencode-workspaces-plugin-sdk2 (`f9dc243`, 3 commits). Evidence: `apps/opencode-workspaces-plugin/package.json:29` (exact pin, was `^0.163.0`) and `:39` (Node floor); v0 `list()` returns an async iterator (ref: sdk-ts:v0/Daytona.d.ts:368).
- Forced breaks: Node floor; README floor, install and self-hosted lines.
- Codemod: walked the dot-directory `.opencode/plugin/daytona/index.ts` itself; 5 root-client calls moved to `.v0`. It did **not** rewrite the test files: it inserted 14 FIXMEs in `test/*.test.ts` instead. An independent review found those calls broken under the pin (several in `afterAll` cleanups, one inside a silent `try/catch` that would leak sandboxes), so they were fixed in commit `6d5b9fa` (including `for await` over `v0.list()`).
- FIXMEs: 14 inserted / 14 resolved / 0 ledgered; 2 idempotence notices ledgered.
- CI parity (not in `ci.yml`): `npm ci --ignore-scripts` / typecheck / build 0/0/0 before and after. The tsconfig excludes `test/`, so an out-of-program `tsc` gate (14 -> 0 TS2339 errors) is the proof for the tests; the bun suites weren't run.
- Live v0 smoke: CREATE_OK, ENVVARS_OK, UPLOAD_EXEC_OK, STOP_OK, STOP_START_OK (file persisted), PREVIEW_OK, NOTFOUND_OK, DELETE_CONFIRMED. Sandboxes 1 / 1.

### stripe-coding-agent-template

- Verdict: READY-WITH-CHANGES. Branch https://github.com/daytona/integrations/tree/feat/stripe-coding-agent-template-sdk2 (`53b2350`, 4 commits). Evidence: `apps/stripe-coding-agent-template/package.json:7` (Node floor) and `:35` (exact pin, was `0.184.0`); the root rejects `apiUrl` (ref: sdk-ts:Daytona.js:173).
- Forced breaks: `apiUrl` / `DAYTONA_SANDBOX_API_URL` dropped from `app/api/copilotkit/route.ts` (`feat!`, commit #1); `organizationId` stays (it's a valid root field). Node floor. Residual "stay on 0.x" wording in README, `.env.example`, `.env.local.example`, `AGENTS.md` and a route comment was aligned afterwards.
- Codemod: exit 2 (`custom-api-url`) before commit #1, exit 0 after (no `--drop-api-url`, no `--force`); apply exit 0; 0 FIXMEs; 2 `env-api-url` items reviewed.
- CI parity (not in `ci.yml`): `npm ci`, `npx tsc --noEmit`, `next build` exit 0. The baseline build needed a placeholder key; the branch builds without one. The CJS-only `./v0` entry is in the Next server output via the nft trace. Next prints a non-fatal "Critical dependency" warning from the SDK's v2 events module (the baseline had the same warning class). npm prints the same `@opentelemetry/api` ERESOLVE peer warnings as inngest (not added).
- Live v0 smoke: passed. Sandboxes 1 / 1.
- Note: `engines.node: ">=22.4.0"` is open-ended, so Vercel may pick Node 22 or 24; both satisfy the SDK.

## 4. Who is excluded by SDK 2

**Every self-hosted or custom-endpoint user is excluded.** SDK 2.x targets Daytona Cloud only: the TS root constructor throws a TypeError on `apiUrl` (ref: sdk-ts:Daytona.js:173), the Python root config raises a TypeError on `api_url` (ref: sdk-py:daytona/_client.py:202), and both SDKs carry the message "SDK 2.x targets Daytona Cloud. For a custom API URL, stay on SDK 0.x." (ref: sdk-ts:Daytona.js:71) (ref: MIGRATION:32). Both codemods refuse a project with a custom URL (exit 2) and say the same.

Four packages had to remove an option to migrate:

| integration | removed option | repo evidence (origin/main) |
|---|---|---|
| stripe-coding-agent-template | `apiUrl` from `DAYTONA_API_URL` / `DAYTONA_SANDBOX_API_URL` with a Cloud fallback | `apps/stripe-coding-agent-template/app/api/copilotkit/route.ts:22-30` |
| agentenv-daytona | `api_url` / `target` config keys | `packages/agentenv-daytona/agentenv_daytona/provider.py:61-63` |
| dify-plugin | `api_url` credential field | `apps/dify-plugin/provider/daytona.yaml:35-50` |
| pydantic-ai-daytona | `api_url` / `target` constructor options | `packages/pydantic-ai-daytona/pydantic_ai_daytona/_session.py:103-105` |

**Correction to the plan's assumption.** The plan expected `.v0` to keep honouring `DAYTONA_API_URL`. It doesn't:

- The `.v0` client created by the root reads only `DAYTONA_V0_API_URL` and otherwise uses `https://app.daytona.io/api`; it never reads `DAYTONA_API_URL` (ref: sdk-ts:Daytona.js:19) (ref: sdk-ts:Daytona.js:11) (ref: sdk-py:daytona/_client.py:55) (ref: sdk-py:daytona/_client.py:52). The root passes that URL explicitly, so the bundled v0 constructor's own `DAYTONA_API_URL` fallback never runs (ref: sdk-ts:Daytona.js:275) (ref: sdk-ts:v0/Daytona.js:234).
- v2 reads `DAYTONA_V2_API_URL`, then `DAYTONA_API_URL` (ref: sdk-ts:v2/Daytona.js:447) (ref: sdk-py:daytona/_client.py:165).
- **Consequence:** a user who upgrades with `DAYTONA_API_URL` still pointing at a self-hosted install sends every v0 call to Daytona Cloud. Their key will usually fail there, but nothing warns them. Measured offline in the pi-extension lane: with `DAYTONA_API_URL` set to a custom URL, the root `.v0` client had `apiUrl=https://app.daytona.io/api`.
- `DAYTONA_TARGET` still applies to v0: the root passes `this.config.target` (undefined unless the deprecated root `target` is set), so the bundled v0 env fallback reads it (ref: sdk-ts:Daytona.js:274) (ref: sdk-ts:v0/Daytona.js:235). The same pi-extension probe saw `target=eu`.
- `DAYTONA_V0_API_URL` is an undocumented override present in alpha.5. **It wasn't tested**, and the tool and SDK messages direct custom-endpoint users to stay on SDK 0.x, so this report doesn't recommend it.

Every Step A branch README now says the last self-hosted-capable release is the one built on Daytona SDK 0.x. The REST-only convex and n8n packages keep their base-URL fields for now; a v2 rewrite would have to decide the same question (§7).

## 5. v2 PoC results

Four integrations got a real `daytona.v2` port on a branch stacked on their Step A branch, run live against microVMs. These branches aren't meant to merge.

| integration | `-v2` branch@sha | Step A parent | step_b verdict | live-proven sha -> final sha |
|---|---|---|---|---|
| daytona-adk | `feat/daytona-adk-sdk2-v2@76813ba` | `4f928ea` | BLOCKED-BY-V2-GAP(sessions:create_session) | `d671fb5` -> `76813ba` |
| langchain-daytona-data-analysis | `feat/langchain-daytona-data-analysis-sdk2-v2@230eccf` | `b3dfaa6` | READY-WITH-CHANGES (breaking) | `f1281a1` -> `230eccf` |
| inngest-agentkit-coding-agent | `feat/inngest-agentkit-coding-agent-sdk2-v2@ae51d35` | `42eeb60` | BLOCKED-BY-V2-GAP(sessions) | `85d4a0b` -> `ae51d35` |
| stripe-coding-agent-template | `feat/stripe-coding-agent-template-sdk2-v2@c42ef43` | `53b2350` | BLOCKED-BY-V2-GAP(sessions) | `b169c7f` -> `c42ef43` |

**Honest note on revisions.** Each PoC's live run used the earlier revision in the last column. Review rounds then removed readiness-harness values from app code (hard-coded labels, lifecycle limits, create waits, exec deadlines) and restored v0 tool contracts. Those fixes kept the v2 call shapes and were verified offline only (build, unit tests, call-shape repros); the budget didn't allow another live run.

### Measured v2 facts (measured 2026-11-02)

- Create latency 786 ms (Python) and 853 ms (TypeScript) from a registered image id; inngest app creates took 790 ms and 340 ms.
- Default user `root`, home `/root`, cwd `/root` in both SDKs (v0 used `daytona` and `/home/daytona`).
- Labels are accepted on create (recovered by exact label match); region `ash-1`.
- No default image is configured for the org: an imageless create fails with `DEFAULT_IMAGE_NOT_CONFIGURED`, so a registered `img_` id is required. A raw registry string isn't a create source (ref: mapping:3773) (ref: mapping:3782). An image built from `python:3.12-slim` plus pandas, matplotlib and numpy was registered and used by every PoC (Debian 13, Python 3.12.16; no node, npm, curl or `free`).
- `run_code` returns an `InterpreterResult` with `process`, `results`, `logs` and optional `error` (ref: sdk-ts:v2/types.d.ts:990) (ref: sdk-py:daytona/v2/types.py:1163); results are MIME-keyed, and a matplotlib plot came back as one `image/png` result.
- Public-port preview returned HTTP 200 without a token and 200 with the preview header; the token is empty for public ports (ref: sdk-ts:v2/Ports.d.ts:75). Private-port token preview is **unmeasured**.
- A fresh client's `v2.get(id)` works (TS GET_FRESH_CLIENT_OK, Python LIVE_GET_OK); a missing id raises v2 `NotFoundError` (404).
- **Session creation is rejected by the deployed daemon**: `invalid request body: unknown variant session, expected one of exec, pty, code`, HTTP 422 `UnprocessableEntityError` in TS. The SDK sends `kind: "session"` (ref: sdk-py:daytona/v2/process.py:401) (ref: sdk-ts:v2/Process.d.ts:60). Non-session background processes work: an exec-launched HTTP server stayed up and served the preview.
- **Images API decoders are broken in both SDKs** on a missing `region_id`: Python images list raises BadRequestError and get/promote raise `KeyError('region_id')` (ref: sdk-py:daytona/v2/_core.py:1262); TS throws `image.region_ids is not iterable` (ref: sdk-ts:v2/Image.js:123). The Python public sandbox list/search read also failed while the wire omitted the required `region_id` (ref: sdk-py:daytona/v2/_gen/api/models/sandbox_list_item.py:69).

### daytona-adk PoC

- Verdict: BLOCKED-BY-V2-GAP(sessions:create_session). Evidence: `packages/adk-plugin/daytona_adk/tools.py:346` (Step A line, `process.create_session(session_id)`) (ref: sdk-py:daytona/v2/process.py:401).
- Ledger: 16 call rows, 14 `none`, 2 BLOCKED (session create and session command start). Code, argv (via a `sys.argv` preamble, since the interpreter has no argv option), env, error, shell, timeout, file round trip and JS/TS cleanup paths passed live; the root client stays synchronous and v2 calls run on a worker because the v2 bridge rejects calls inside an active event loop. `auto_stop_interval` and `auto_delete_interval` map to lifecycle policies with different clocks (a deliberate, ledgered semantic change). 2 sandboxes created / 2 deleted.

### langchain-daytona-data-analysis PoC

- Verdict: READY-WITH-CHANGES (breaking). Evidence: `packages/langchain-data-analysis/langchain_daytona_data_analysis/tools.py:185` (Step A line, callback with `execution.artifacts`) (ref: sdk-py:daytona/v2/_sync/sandbox.py:339).
- Ledger: 13 call rows, all `none`. `on_result` now receives the whole `InterpreterResult` instead of `ExecutionArtifacts`, and charts come from `results[].data['image/png']` (chart type/title metadata is gone): a breaking public contract change. The constructor gained an optional `image` argument and `create_kwargs`; uploads go to `/root`. Live: HELLO_OK, PNG_OK, CSV round trip, PIP_EXEC_OK, LIVE_GET_OK, delete. 1 sandbox created / 1 deleted.

### inngest-agentkit-coding-agent PoC

- Verdict: BLOCKED-BY-V2-GAP(sessions). Evidence: `apps/inngest-agentkit-coding-agent/src/index.ts:272` (Step A line, `process.createSession(sessionId)`) (ref: sdk-ts:v2/Process.d.ts:60).
- Ledger: 23 call rows, 4 BLOCKED: 3 session rows (create, start, list/get) and `argv`, which has no v2 interpreter equivalent (ref: sdk-ts:v2/types.d.ts:943); a non-empty `argv` now returns an explicit error, while empty or missing `argv` runs as on v0. Live: CODE_OK, CODE_ENV_OK, ARGV_REJECTED, EXEC_OK, FS_OK; the dev-server path stops at the 422. A second diagnostic run hung in the lane's own log reader (not the API) and was cut off by the outer timeout; its sandbox was deleted, and the reader was fixed offline to bounded paging. 2 sandboxes created / 2 deleted.

### stripe-coding-agent-template PoC

- Verdict: BLOCKED-BY-V2-GAP(sessions). Evidence: `apps/stripe-coding-agent-template/app/api/copilotkit/route.ts:142-143` (Step A lines, background `createSession`) (ref: sdk-ts:v2/Process.d.ts:60).
- Ledger: 27 call rows, 4 BLOCKED (session create on both callers, session start, session logs). Live: file system checks, fresh-client get plus exec, NotFoundError, and the public preview measurement (200 / 200, empty token) passed; `runCommand(background)` and `startWebServer` stop at the 422. Private-preview auth is unmeasured because the route makes ports public. 1 sandbox created / 1 deleted.
- A follow-up commit (`c42ef43`) ported the app's own `scripts/test.mjs` sandbox step to the same v2 calls (offline-checked; the script needs an OpenRouter key and was not run).

## 6. v2 outlines for the other integrations

Each outline lists every v0 call with its v2 form. Repo lines are on the Step A branch named in the heading. After the first full repo path in a subsection, short paths are relative to that package directory. Measured facts are from 2026-11-02 and must be re-checked on the next SDK release.

### pydantic-ai-daytona (`feat/pydantic-ai-daytona-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. Persistence: `packages/pydantic-ai-daytona/pydantic_ai_daytona/_session.py:102-114` attaches by id and calls `sandbox.start()` for stopped sandboxes; v2 create can't make a persistent sandbox (ref: mapping:3767) and only persistent sandboxes stop (ref: mapping:5279). Waits on persistent create in the SDK.
2. Sessions: `packages/pydantic-ai-daytona/pydantic_ai_daytona/_execution.py:73-147` runs every shell command through a session (ref: sdk-py:daytona/v2/process.py:401). Waits on daemon session support, or a port to one-shot `process.run` (measured working; each command already uses a fresh session, so nothing is lost).
3. User and work dir: `_session.py:133` uses `get_work_dir()`, which has no v2 helper (ref: mapping:4862), and Python v2 create has no `user` argument. Waits on Python `create(user=...)` and a work-dir helper.
4. Default image: the imageless default path (`_session.py:194-195`) fails with `DEFAULT_IMAGE_NOT_CONFIGURED`. Waits on an org default image.
5. Decoder: test cleanup needs `v2.list(labels=...)`, broken on the Python read path (ref: sdk-py:daytona/v2/_gen/api/models/sandbox_list_item.py:69). Waits on a post-alpha.5 SDK.
6. `auto_delete_interval` (`_session.py:192`) has no v2 equivalent (ref: mapping:5080).

Ready now: exec -> `process.run`, file system (`stat`, `read_bytes`, `write_bytes`, `list`), owned create/delete with a registered image, `refresh_data`, v2 errors. Recommendation: keep on `.v0` this release; port the owned-sandbox flow first once persistent create, Python `user=` and the decoder fix land.

### agentenv-daytona (`feat/agentenv-daytona-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. Image build: `packages/agentenv-daytona/agentenv_daytona/image.py:48-55` builds a host image with `Image.base(...)`; v2 needs `create_from_build` (ref: mapping:3772), whose follow-up `images.get` raises `KeyError('region_id')` in alpha.5 (ref: sdk-py:daytona/v2/_core.py:1262), and the `USER daytona` step isn't carried (ref: docs:images:586). Waits on a decoder fix plus Python `create(user=...)` or a root recipe.
2. Docker-in-Docker: `agentenv_daytona/sandbox.py:163-201` starts `dockerd`; never run inside a v2 microVM. Waits on one live DinD verification.
3. Sessions: `agentenv_daytona/sandbox.py:140-156` is the only exec path, including the dockerd start (ref: sdk-py:daytona/v2/process.py:401). Workaround: `process.run` / `process.start` (ref: sdk-py:daytona/v2/process.py:424); whether a detached dockerd outlives an exec process is unmeasured.
4. Network policy: `agentenv_daytona/sandbox.py:220-230` `update_network_settings` becomes an etag read-modify-write of the whole policy (ref: mapping:5331).
5. Resources: `agentenv_daytona/config.py:86-92` assumes fixed allocations; v2 has request/limit pairs. Needs a mapping and billing decision.
6. Name lookup after a lost create (`agentenv_daytona/lifecycle.py:181-202`) needs `find_by_name` (ref: mapping:3900) on the broken search path.
7. Upstream agentenv-framework built-in provider (§2), which blocks Step A users too.

Ready now: `write_bytes`, delete with 409 handling, `refresh_data`, labels, `ttl_minutes` -> lifecycle timeout, snapshot create once re-registered as an image. Recommendation: keep on `.v0`, no partial port; fix the framework upstream first, then wait for working `create_from_build` and a live DinD check.

### daytona-claude-toolsets (`feat/daytona-claude-toolsets-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. `mouse.down/up` at `packages/claude-toolsets/python/daytona_claude_toolsets/computer.py:467-480` (ref: mapping:3087) (ref: sdk-py:daytona/v2/computer_use_services.py:136).
2. Click count (triple click) at `computer.py:316-324` (ref: mapping:3149).
3. Mouse modifiers on click, drag and scroll at `computer.py:325,459,494` (ref: mapping:3176).
4. Horizontal scroll at `computer.py:488-495` (ref: mapping:3203).
5. `keyboard.down/up` for `hold_key` at `computer.py:534-571` (ref: mapping:816).
6. Desktop image: v0 uses the default desktop snapshot (`_sandbox.py:86`); v2 has no default image and no measured desktop image.
7. `on_close="stop"` at `_sandbox.py:66-67` needs persistence (ref: mapping:5279).
8. Sessions: Chromium launch at `daytona_claude_toolsets/_chromium.py:72-75` (ref: sdk-py:daytona/v2/process.py:401); workaround `process.start`.

Each of 1-5 waits on the matching v2 computer-use feature. The package's XTest fallback (`_xtest.py`) could emulate held input on v2, but it needs X11 libraries and a display in the image and is unverified. Ready now: screenshot, move, single/double click, unmodified drag and vertical scroll, `key`, `type`, cursor position, display info, exec and file plumbing. Recommendation: keep the computer toolset on `.v0`; the browser toolset can move once a v2 Chromium image exists and its launch uses `process.start`.

### dify-plugin (`feat/dify-plugin-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. Persistence: `apps/dify-plugin/tools/manage_sandbox.py:23-35` offers start/stop/archive (ref: mapping:5279) (ref: mapping:4464); `tools/create_sandbox.py:31-38` defaults to auto-stop. Waits on persistent create.
2. Sessions: `tools/start_service.py:29-38` and `tools/get_service_logs.py:26-36` (ref: sdk-py:daytona/v2/process.py:401). The `process.start` workaround changes the tool's `session_id` contract to a process id.
3. Credential check: `provider/daytona.py:17` validates with a list call, which hits the Python list decoder (ref: sdk-py:daytona/v2/_gen/api/models/sandbox_list_item.py:69); the key must also belong to an org with v2 Linux sandboxes enabled.
4. Default image: `tools/run_command.py:32` and `tools/run_code.py:26` create imageless sandboxes; TypeScript/JavaScript code needs Node, which the measured image lacks.
5. `find`/`search` result shapes change (`tools/find_in_files.py:26-36`) (ref: mapping:1175) and preview is unmeasured; both need a live check.
6. Tool descriptions steer the model to `/home/daytona` (`tools/run_command.yaml:41-44`), which doesn't exist under root.

Ready now: 12 of 17 tools have a direct equivalent once an image id is configured (`run_command`, `run_code` with MIME PNG results, file tools, `git.clone`, destroy). Recommendation: keep on `.v0`; port all tools at once after persistent create, the decoder fix, an org default image and session support.

### claude-toolsets (`feat/claude-toolsets-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. `mouse.down/up`: `packages/claude-toolsets/typescript/src/computer.ts:289,305,441,446` (ref: sdk-ts:v2/ComputerUseNamespaces.d.ts:19) (ref: mapping:779).
2. Click count and modifiers: `src/computer.ts:327` (ref: mapping:3154).
3. Drag/scroll modifiers and horizontal scroll: `src/computer.ts:432,455` (ref: mapping:3208).
4. `keyboard.down/up`: `src/computer.ts:514,529` (ref: sdk-ts:v2/ComputerUseNamespaces.d.ts:28).
5. Signed preview: `src/browser.ts:266` builds the CDP endpoint from a signed URL; `ports.signedPreviewLink` exists (ref: mapping:4791) but private and signed previews are unmeasured.
6. Sessions: Chromium launch at `src/chromium.ts:140,149` (ref: sdk-ts:v2/Process.d.ts:60); workaround `process.start` (ref: sdk-ts:v2/Process.d.ts:32).
7. Desktop image: `src/sandbox.ts:59` creates without a snapshot; no default or desktop image on v2.
8. `onClose: "stop"` at `src/sandbox.ts:133` needs persistence (ref: mapping:3776).

Ready now: start, delete, `refreshData`, `resetIdleTimer`, `process.run`, file writes and deletes, computer-use status/start/display/position/move/screenshot/type/key, plain clicks and unmodified vertical scroll. Recommendation: keep on `.v0`. A split port (v2 for screenshots, v0 for held input) doesn't work because one sandbox can't be created through both namespaces.

### opencode-plugin (`feat/opencode-plugin-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. SSH access: `packages/opencode-plugin/.opencode/plugin/daytona/git/session-git-manager.ts:128` mints a 600-second SSH token for git sync; `createSshAccess` and its revoke have no v2 equivalent (ref: mapping:4560) (ref: MIGRATION:264). Waits on a v2 SSH or git credential path and a published v2 gateway host key.
2. Persistence: `core/session-manager.ts:123-143` reattaches by id and calls `start()` (ref: mapping:3776). Waits on persistent create.
3. Sessions: the background path of `tools/bash.ts:28-45` uses sessions (ref: sdk-ts:v2/Process.d.ts:60); `process.start` works but loses the shared shell state (cwd, exports).
4. `getWorkDir` (`tools/glob.ts:23`) has no v2 helper (ref: mapping:4878); `REPO_PATH = '/home/daytona/project'` (`index.ts:45`) doesn't exist under root.
5. Default image: `core/session-manager.ts:205` omits the snapshot.

(All paths above are under `packages/opencode-plugin/.opencode/plugin/daytona/`.) Ready now: foreground bash -> `process.run`, file tools, preview URL, `refreshData`, delete, get by id. Recommendation: keep on `.v0`; re-evaluate when v2 ships persistent create, an SSH/git credential path and session support.

### pi-extension (`feat/pi-extension-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. List pagination: `packages/pi-extension/index.ts:494` consumes `v0.list()` with `for await`; v2 `list` returns one page (ref: sdk-ts:v2/Daytona.d.ts:217) and label filtering goes through the eventually consistent search path, whose Python decoder failed. Waits on a fixed list/search decoder and `iter({ labels })` (ref: mapping:3930).
2. Persistence: `index.ts:248` reattaches by id; `index.ts:280-281` relies on idle stop and `autoDeleteInterval: -1` (ref: mapping:3776) (ref: mapping:5097). Waits on persistent create and a never-delete lifecycle.
3. Home dir: `index.ts:286` and `scripts/bash-bg.mjs:53` use `getUserHomeDir() ?? '/home/daytona'`; no v2 helper (ref: mapping:4832).
4. Sandbox-wide `public` at `index.ts:275`; v2 visibility is per port (ref: mapping:5204), and an API-key preview token is port-scoped with a 3600-second default lifetime (ref: docs:preview:258).
5. Default image: `index.ts:268-274` passes an optional snapshot name.

Ready now: `process.run`, file read/write, git status/clone/push, preview link, `refreshData`, delete, get by id; the ephemeral scripts apart from the home fallback. Recommendation: keep on `.v0`.

### opencode-workspaces-plugin (`feat/opencode-workspaces-plugin-sdk2`)

Verdict BLOCKED-BY-V2-GAP. Blockers:

1. Never-delete lifecycle: `apps/opencode-workspaces-plugin/.opencode/plugin/daytona/index.ts:237` sets `autoDeleteInterval: -1`; no v2 equivalent (ref: mapping:5080) (ref: MIGRATION:285).
2. Stop/start: `index.ts:365-371` resumes a stopped workspace (proven on v0 by STOP_START_OK) (ref: mapping:3776).
3. Preview token: `index.ts:374-375` caches the token as a static header; v2 API-key tokens are port-scoped with a 3600-second default lifetime (ref: docs:preview:258) and need re-minting. Private preview is unmeasured.
4. Get by name: `index.ts:343,365` need `findByName` (ref: mapping:3904) on the search path.
5. Paths and tools: `HOME_PATH = '/home/daytona'` (`index.ts:60`) under root, and the health check and installer need `curl` (`index.ts:136,298`), absent from the measured image.

Ready now: `process.run`, uploads, delete, preview URL template, `name` and `env` create options. Recommendation: keep on `.v0`; re-evaluate with persistent create plus a never-delete lifecycle and a live preview measurement.

## 7. REST-only packages (convex, n8n)

Neither package depends on the SDK, so the codemods don't apply and v0 REST keeps working as long as the v0 platform exists. Both were mapped endpoint by endpoint at origin/main `ec6f147`, which includes #101 (volume mounts on create, released as convex 2.2.0).

| package | rows | SAME | CHANGED | NO-V2-EQUIVALENT | verdict |
|---|---|---|---|---|---|
| convex | 29 (20 endpoint rows incl. the #101 `volumes` body key, 9 cross-cutting) | 5 | 23 | 1 | BLOCKED-BY-REWRITE |
| n8n-nodes-daytona | 52 (35 endpoint constants, 1 extra call site, 7 transport helpers, 9 cross-cutting) | 15 | 29 | 8 | BLOCKED-BY-REWRITE |

### convex

Verdict BLOCKED-BY-REWRITE. Evidence: `packages/convex/src/component/daytona.ts:156-158` (`POST /sandbox`, origin/main) (ref: sdk-ts:v2/gen/api.d.ts:1679); the #101 `volumes` key at `packages/convex/src/component/sandboxes.ts:227-228` has no public v2 path because the SDK create mapping for volumes is commented out (ref: sdk-ts:v2/Daytona.js:608) and volumes aren't on v2 yet (ref: mapping:4150). Changes: paths pluralised, `/process/*` -> `/processes`, preview GET -> POST, new state vocabulary, `/home/daytona` -> `/root`, new base URL; `stop` needs persistent create (ref: mapping:3776). Stored `state` strings and v0 sandbox ids in the component table don't carry over (ref: mapping:170), so this needs a major version.

**Recommendation:** hand-port the `fetch` client; don't adopt `@daytona/sdk` v2. Convex's default runtime has `fetch` but not the Node APIs the SDK needs (`packages/convex/src/component/daytona.ts:6-15`), the SDK needs Node `>=22.4.0` (ref: sdk-ts:package.json:167), and a hand-written client can tolerate the missing `region_id` that breaks the SDK decoders. Start only when volumes are relaunched, persistent create exists, a default image is documented, and the self-hosted question (`DAYTONA_API_URL`, `packages/convex/README.md:72`) is decided.

### n8n-nodes-daytona

Verdict BLOCKED-BY-REWRITE. Evidence: every call goes through `httpRequestWithAuthentication` in `packages/n8n-nodes-daytona/nodes/Daytona/helpers/transport.ts:48-139` (origin/main); the credential test `GET /api-keys/current` keeps its path (ref: sdk-ts:v2/gen/api.d.ts:17). NO-V2-EQUIVALENT: Snapshot Activate/Deactivate (ref: mapping:4004), all four Volume operations and create-time volume mounts (ref: sdk-ts:v2/Daytona.js:497) (ref: mapping:4150), and the `X-Daytona-Organization-ID` credential field (the org is a path segment in v2). Outputs become snake_case with cursor pagination, code results lose `result`/`artifacts`, previews become POST, Stop/Start need persistence, and saved workflows with v0 ids can't be replayed (ref: mapping:170).

**Recommendation:** hand-port REST inside the existing transport after the feature gaps close; keep n8n credential handling rather than adopting the SDK. 15 rows (all `/files*` and `/git/*` toolbox routes plus the credential test) are unchanged relative to the base URL.

**Volumes are hidden, not gone.** The v2 SDK has a volume service that is hidden until volumes are relaunched (ref: sdk-ts:v2/Daytona.js:497). The volume rows may become CHANGED instead of NO-V2-EQUIVALENT after the relaunch, so re-map both packages then.

## 8. Flip-to-stable runbook

### 8a. Per-branch flip

| branch | manifest file(s) | current pin -> GA pin | lockfile command | CI-parity commands |
|---|---|---|---|---|
| `feat/daytona-adk-sdk2` | `packages/adk-plugin/pyproject.toml` | `daytona[v0-sdk]==2.0.0a5` -> `daytona[v0-sdk]>=2,<3` (or `>=2.0,<2.1`) | none (no lock) | `python -m pip install -e ".[dev]" && ruff check .` |
| `feat/langchain-daytona-data-analysis-sdk2` | `packages/langchain-data-analysis/pyproject.toml` | `daytona = {version = "2.0.0a5", extras = ["v0-sdk"]}` -> `daytona = {version = ">=2,<3", extras = ["v0-sdk"]}` | none (`poetry.lock` is gitignored) | `poetry install --with test,lint && poetry run ruff check . && poetry run pytest tests/unit_tests` |
| `feat/pydantic-ai-daytona-sdk2` | `packages/pydantic-ai-daytona/pyproject.toml` | `daytona[v0-sdk]==2.0.0a5` -> `daytona[v0-sdk]>=2,<3` | none | `python -m pip install -e ".[dev]" && ruff check . && pytest` |
| `feat/agentenv-daytona-sdk2` | `packages/agentenv-daytona/pyproject.toml` | `daytona[v0-sdk]==2.0.0a5` -> `daytona[v0-sdk]>=2,<3` (or `>=2.0,<2.1`) | none | `python -m pip install -e ".[dev]" && ruff check . && black --check . && mypy agentenv_daytona && pytest` |
| `feat/daytona-claude-toolsets-sdk2` | `packages/claude-toolsets/python/pyproject.toml` | `daytona[v0-sdk]==2.0.0a5` -> `daytona[v0-sdk]>=2,<3` (or `>=2.0,<2.1`) | none | `python -m pip install -e ".[dev]" && ruff check . && mypy daytona_claude_toolsets && pytest` |
| `feat/claude-toolsets-sdk2` | `packages/claude-toolsets/typescript/package.json` | `"@daytona/sdk": "2.0.0-alpha.5"` -> `"^2.0.0"` | `npm install` | `npm ci --ignore-scripts && npm run typecheck && npm run build && npm test` |
| `feat/pi-extension-sdk2` | `packages/pi-extension/package.json` | `"@daytona/sdk": "2.0.0-alpha.5"` -> `"^2.0.0"` | `npm install` | `npm ci --ignore-scripts && npm run typecheck --if-present && npm run build --if-present` |
| `feat/opencode-plugin-sdk2` | `packages/opencode-plugin/package.json` | `"@daytona/sdk": "2.0.0-alpha.5"` -> `"^2.0.0"` | `npm install` | `npm ci --ignore-scripts && npm run typecheck --if-present && npm run build --if-present` |
| `feat/dify-plugin-sdk2` | `apps/dify-plugin/pyproject.toml`, `apps/dify-plugin/requirements.txt` | `daytona[v0-sdk]==2.0.0a5` -> `daytona[v0-sdk]>=2,<3` (both files) | `uv lock` | `uv lock --check && uv sync --frozen && uv run python -c 'import _client, provider.daytona'` |
| `feat/inngest-agentkit-coding-agent-sdk2` | `apps/inngest-agentkit-coding-agent/package.json` | `"@daytona/sdk": "2.0.0-alpha.5"` -> `"^2.0.0"` | `npm install` | `npm ci && npm run build && docker build .` |
| `feat/opencode-workspaces-plugin-sdk2` | `apps/opencode-workspaces-plugin/package.json` | `"@daytona/sdk": "2.0.0-alpha.5"` -> `"^2.0.0"` | `npm install` | `npm ci --ignore-scripts && npm run typecheck && npm run build` |
| `feat/stripe-coding-agent-template-sdk2` | `apps/stripe-coding-agent-template/package.json` | `"@daytona/sdk": "2.0.0-alpha.5"` -> `"^2.0.0"` | `npm install` | `npm ci && npx tsc --noEmit && npm run build` |

Range notes:

- `>=2,<3` is wide on purpose for pydantic-ai-daytona and langchain-daytona-data-analysis: the maintainers' comment on #102 says a one-minor pin can't share an environment with other Daytona SDK users.
- daytona-adk (`>=0.194.0,<0.195.0`), agentenv-daytona (`>=0.224.0,<0.225.0`) and daytona-claude-toolsets (`>=0.223.0,<0.224.0`) used one-minor windows on main and may prefer `>=2.0,<2.1`.
- In Poetry syntax the wide range is `daytona = {version = ">=2,<3", extras = ["v0-sdk"]}`.
- Keep the `>=22.4.0` Node engines and the langchain `>=3.10` floor unless 2.0.0 changes them.

### 8b. GA order of operations

1. Wait for stable `@daytona/sdk@2.0.0` and `daytona==2.0.0`. Re-run the §10 checks against them.
2. Rebase each branch on origin/main. Drift today (from `14cfd49` to `ec6f147`): b31cb0b (#100) touches `tools.py` and tests; ae236b6 (#104) is the 0.2.1 release commit (CHANGELOG.md, the pyproject version line, the release-please manifest); a trial merge of the Step A branch onto origin/main was conflict-free. Every other branch has none. Recheck the others at GA.
3. Flip the pin (§8a).
4. Regenerate the lock where one exists.
5. Run the CI-parity commands.
6. Open one PR per branch. The `-v2` PoC branches are not meant to merge.

The in-flight branches the plan listed for rebasing, `fix/langchain-data-analysis-chart-context`, `fix/langchain-data-analysis-stray-none` and `fix/pydantic-ai-daytona-sdk-range`, were merged as #99, #100 and #102 and no longer exist on origin. Only local copies remain in some checkouts.

### 8c. Reproduce Step A for one package (pi-extension)

These are the commands from the pi-extension ledger. A self-test on a scratch copy reproduced the branch's `index.ts`, `package.json`, `scripts/` and `src/` byte for byte, and `package-lock.json` byte-identical on 2026-11-02 (later resolution drift is possible). README edits are docs-only and not reproduced. Set `R` to your clone and `W` to a scratch path. `npm ci --ignore-scripts` **must** run before the codemod: without installed types the TS codemod reports `types-unresolved` and inserts 3 extra FIXMEs (`index.ts:367`, `scripts/bash-bg.mjs:121`, `scripts/cwd.mjs:101`) that the fixes below don't remove.

```bash
export CI=true GIT_TERMINAL_PROMPT=0 GIT_EDITOR=: GIT_PAGER=cat PAGER=cat npm_config_yes=true npm_config_fund=false npm_config_audit=false
R=/home/opencode/projects/integrations; W=/home/opencode/projects/integrations-wt/f3-pi
git -C $R fetch origin
git -C $R worktree add --detach $W origin/main          # pi-extension is identical at 14cfd49 and ec6f147
test ! -e $W/.env
cd $W/packages/pi-extension
# 1 baseline (mandatory before the codemod)
npm ci --ignore-scripts && npm run typecheck && npm run smoke
# 2 read-only codemod passes (porcelain must stay empty)
npx -y @daytona/upgrade@0.1.0 . --dry
npx -y @daytona/upgrade@0.1.0 . --dry --json
test -z "$(git -C $W status --porcelain)"
# 3 apply (exit 0; 4 manual items: index.ts:430 mock-target, 3x dynamic-import)
npx -y @daytona/upgrade@0.1.0 . --yes --json
# 4 pin exact alpha + engines BEFORE any install
sed -i 's|"@daytona/sdk": "\^2.0.0"|"@daytona/sdk": "2.0.0-alpha.5"|' package.json
sed -i '/^  "peerDependencies": {/i\  "engines": {\n    "node": ">=22.4.0"\n  },' package.json
jq -e '.dependencies["@daytona/sdk"]=="2.0.0-alpha.5" and .engines.node==">=22.4.0"' package.json
# 5 install + CI parity
npm install
rm -rf node_modules && npm ci --ignore-scripts
jq -r '.packages["node_modules/@daytona/sdk"].version' package-lock.json   # 2.0.0-alpha.5
# 6 manual fixes (false-positive FIXME; v0 error import in recovery.mjs)
perl -0pi -e 's/      if \(daytona\)\n      \/\/ FIXME\(daytona-upgrade\): [^\n]*\n      await reapOrphans\(daytona\)\n/      if (daytona) await reapOrphans(daytona)\n/' index.ts
perl -pi -e 's/^const \{ Daytona, DaytonaNotFoundError \} = await import\(\x27\@daytona\/sdk\x27\)$/const { Daytona } = await import(\x27\@daytona\/sdk\x27)\nconst { DaytonaNotFoundError } = await import(\x27\@daytona\/sdk\/v0\x27)/' scripts/recovery.mjs
test "$(grep -rn 'FIXME(daytona-upgrade)' . --exclude-dir=node_modules | wc -l)" = 0
# 7 verify + V0 ESM interop
npm ci --ignore-scripts && npm run typecheck && npm run smoke
node -e "import('@daytona/sdk/v0').then(m=>{if(!m.DaytonaError)process.exit(1);console.log('V0_ESM_OK')})"
# 8 compare with the pushed branch (expected: no output)
git -C $R fetch origin feat/pi-extension-sdk2
mkdir -p /tmp/f3-pi-ref && git -C $R archive origin/feat/pi-extension-sdk2 packages/pi-extension | tar -x -C /tmp/f3-pi-ref
git diff --no-index --exit-code -- /tmp/f3-pi-ref/packages/pi-extension/index.ts index.ts
for f in package.json scripts src; do git diff --no-index --exit-code -- /tmp/f3-pi-ref/packages/pi-extension/$f $f; done
# 9 cleanup
cd / && git -C $R worktree remove --force $W && rm -rf /tmp/f3-pi-ref
```

`npm run smoke` is the package's offline smoke. A live v0 smoke additionally needs a Daytona API key and creates one labelled sandbox.

### 8d. release-please version consequences

The branches use `feat!` commits with `BREAKING CHANGE` footers. `release-please-config.json` has no `bump-minor-pre-major`, so a breaking change on a 0.x package jumps to 1.0.0. Current versions from `.release-please-manifest.json` on origin/main `ec6f147`:

| component | current | after merge at GA |
|---|---|---|
| daytona-adk | 0.2.0 | 1.0.0 |
| langchain-daytona-data-analysis | 0.2.1 | 1.0.0 |
| pydantic-ai-daytona | 0.2.1 | 1.0.0 |
| agentenv-daytona | 0.1.0 | 1.0.0 |
| daytona-claude-toolsets | 0.1.1 | 1.0.0 |
| claude-toolsets | 1.0.0 | 2.0.0 |
| pi-extension | 0.191.2 | 1.0.0 |
| opencode-plugin | 0.193.0 | 1.0.0 |
| convex | 2.2.0 | unchanged (no branch) |
| n8n-nodes-daytona | 0.1.3 | unchanged (no branch) |

The four apps (dify, inngest, opencode-workspaces, stripe) aren't released by release-please. To avoid the 1.0.0 jumps, set `"bump-minor-pre-major": true` in `release-please-config.json` before merging; the 0.x packages then get a minor bump instead.

### 8e. Optional live integration run

`integration.yml` has a `workflow_dispatch` input named `package` with choices `all`, `adk`, `convex`, `langchain`, `n8n`, `pi`, `pydantic-ai`, `agentenv-daytona`. Five branches have a suite:

```bash
gh workflow run integration.yml --repo daytona/integrations --ref feat/daytona-adk-sdk2 -f package=adk
gh workflow run integration.yml --repo daytona/integrations --ref feat/langchain-daytona-data-analysis-sdk2 -f package=langchain
gh workflow run integration.yml --repo daytona/integrations --ref feat/pi-extension-sdk2 -f package=pi
gh workflow run integration.yml --repo daytona/integrations --ref feat/pydantic-ai-daytona-sdk2 -f package=pydantic-ai
gh workflow run integration.yml --repo daytona/integrations --ref feat/agentenv-daytona-sdk2 -f package=agentenv-daytona
```

Each run waits for approval of the `integration-tests` environment and creates real sandboxes. The agentenv run will hit the upstream provider conflict from §2.

## 9. Spend and cleanup proof

Every live sandbox was labelled `sdk2-readiness=<component>`, journaled on create and deleted in a `finally` path.

| component | v0 created | v0 deleted | v2 created | v2 deleted |
|---|---|---|---|---|
| daytona-adk | 1 | 1 | 2 | 2 |
| langchain-daytona-data-analysis | 1 | 1 | 1 | 1 |
| pydantic-ai-daytona | 1 | 1 | 0 | 0 |
| agentenv-daytona | 1 | 1 | 0 | 0 |
| daytona-claude-toolsets | 1 | 1 | 0 | 0 |
| claude-toolsets | 1 | 1 | 0 | 0 |
| pi-extension | 1 | 1 | 0 | 0 |
| opencode-plugin | 2 | 2 | 0 | 0 |
| dify-plugin | 1 | 1 | 0 | 0 |
| inngest-agentkit-coding-agent | 1 | 1 | 2 | 2 |
| opencode-workspaces-plugin | 1 | 1 | 0 | 0 |
| stripe-coding-agent-template | 1 | 1 | 1 | 1 |
| convex, n8n-nodes-daytona | 0 | 0 | 0 | 0 |
| v2 probe | 0 | 0 | 2 | 2 |
| **total** | **13** | **13** | **8** | **8** |

- v0: 13 created, 13 deleted (budget 14). v2: 8 created, 8 deleted (budget 10). Leftovers: 0.
- Four sweep runs on 2026-11-03 each found 0 labelled v0 sandboxes for all 15 label values, all 8 recorded v2 ids absent (6 destroyed, 2 not found), and 0 active v2 sandboxes in a label search for all 15 values (`LEFTOVERS=0`).
- 16 local worktrees (12 Step A, 4 PoC) were removed after a clean-and-pushed check; all 16 branches remain on origin.
- One registered v2 image (the PoC image) is retained for the final checks, which add at most 1 v0 and 1 v2 sandbox. It is deleted in the final cleanup after the last check. A pre-existing image in the org was left untouched.

## 10. Risks and unverified items

- **Alpha drift.** Everything here is pinned to alpha.5, and the SDK may change between alphas. Re-run the codemod dry passes and the CI-parity commands on each new alpha and at 2.0.0.
- **PyPI ordering.** `daytona` `2.0.0rc1` (published 2026-09-09) outranks `2.0.0a5` (2026-11-02) under PEP 440, so `pip install --pre daytona` or `uv --prerelease=allow` resolves rc1. Pins must stay exact until 2.0.0.
- **No published GA date** for SDK 2.0.0.
- **Session rejection may be a deployment state.** The 422 comes from the deployed daemon, while the SDK documents sessions. A daemon update could clear the dominant Step B blocker without any SDK change. Re-test before acting on the session verdicts.
- **Offline-only fix rounds.** The final revision of each `-v2` branch wasn't re-run live (§5).
- **Private preview auth is unmeasured**; only public-port preview was measured. Signed preview links are unmeasured.
- **Docker-in-Docker inside a microVM is unverified** (agentenv).
- **Images decoder defects** in both SDKs and the Python list/search decoder (§5). Create by `img_` id and `v2.get` by id work.
- **Codemod defects and quirks:** the `@daytona/upgrade@0.1.0` whole-package scan hangs on claude-toolsets typescript (apply per folder); the JSON report key is `.changedFiles`; dot-directory traversal worked (opencode-plugin, opencode-workspaces-plugin); the TS codemod output depends on `npm ci` having run first (§8c); it re-proposes widening the exact pin on every re-run; it under-reports calls on receivers typed `Any` (agentenv) and doesn't route bare test doubles (daytona-claude-toolsets, opencode-workspaces-plugin tests).
- **ESM/CJS interop works.** `./v0` is a CJS-only export with no `import` condition (ref: sdk-ts:package.json:40), yet it resolves from ESM (V0_ESM_OK in pi-extension, claude-toolsets, opencode-plugin, inngest), and the ESM root loads the same CJS v0 so `instanceof` holds. Next bundles it through the nft trace (stripe).
- **agentenv-framework upstream conflict** (§2). Until it ships a fix, agentenv-daytona on SDK 2 can't be used through `build_sandbox_provider('daytona')` or installed with `agentenv-framework[daytona]`.
- **npm ERESOLVE peer warnings** about `@opentelemetry/api` in inngest and stripe come from the alpha's tree; the package is an optional peer, so it wasn't added.
- **dify venv on Python 3.14** via uv; CI-equivalent Python 3.12 wasn't exercised for the app.
- **Python v2 create has no `user` argument** while TS does; don't forward `user=` from Python code.
- **Persistent Linux sandboxes need org enablement** even after the SDK exposes them (ref: docs:linux-sandboxes:309).
- **Untested app suites:** opencode-workspaces-plugin bun tests (typecheck-only proof), the adk pytest suite (live-gated, all skipped offline), and the stripe app's `scripts/test.mjs` sandbox step (offline-checked but not run; it requires an OpenRouter key).
