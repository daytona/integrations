# agentenv-daytona

Runs [AgentEnv Framework](https://github.com/scaleapi/agentenv-framework) sandboxes on [Daytona](https://www.daytona.io).
Each sandbox is a Daytona sandbox running its own Docker daemon, presented to AgentEnv as a VM. AgentEnv's
docker-in-VM flows run on it unchanged: the gateway's docker-compose, an agent's `docker run`, image loading
and building, and artifact collection.

The package is an AgentEnv plugin. Installing it registers the `daytona` sandbox provider through the
`agent_env.sandbox_providers` entry point, so nothing in AgentEnv itself changes.

## Set up

### 1. Install

```bash
pip install agentenv-daytona      # or: uv add agentenv-daytona
```

It installs `agentenv-framework` and the Daytona Python SDK. `agent-env plugin list` then shows
`sandbox provider daytona`.

### 2. Get a Daytona API key

Create a key in the [Daytona dashboard](https://app.daytona.io/dashboard/keys). For local work, export it:

```bash
export DAYTONA_API_KEY=dtn_...
```

For a shared deployment, put it in your secret store instead, for example as `daytona_api_key`, and reference
it with `secret:daytona_api_key`. Never put the key itself in `config.toml`. The provider reads the key only
from its config, never from the process environment.

### 3. Configure

A complete `.agentenv/config.toml` that runs every environment and agent on Daytona, with the local stores:

```toml
[sandbox]
default       = "daytona"   # environments and sandboxes
agent_default = "daytona"   # agents

[sandbox.providers.daytona.config]
api_key = "env:DAYTONA_API_KEY"   # or "secret:daytona_api_key"
```

To keep the local default and use Daytona per run instead, add only the `[sandbox.providers.daytona.config]`
table and pass `--sandbox daytona`. `agent-env config show` prints the file in effect and masks the key.

### 4. Run something

The bundled `hello` task deploys a sandbox, loads a file into it and checks it, with no model needed:

```console
$ agent-env run hello --sandbox daytona
[tasks/hello.json] step 1/3 box (deploy_sandbox)
[tasks/hello.json] step 1/3 box done in 2.4s
[tasks/hello.json] step 2/3 load (load_artifact)
[tasks/hello.json] step 2/3 load done in 1.4s
[tasks/hello.json] step 3/3 hello (verify_sandbox)
[tasks/hello.json] step 3/3 hello done in 0.6s
[tasks/hello.json] passed in 4.4s

Tasks:
  tasks/hello.json v1: passed (hello: 1), 4.4s, instance @local/agentenv-framework/hello/hello-qowoke74

Tore down 1 sandbox.
```

The first sandbox an organization creates also builds the host image (see below), which takes about half a
minute once.

## Configuration reference

All keys go under `[sandbox.providers.daytona.config]`. Unknown keys are refused.

| Key | Default | Meaning |
|---|---|---|
| `api_key` | required | The Daytona API key, as an `env:` or `secret:` reference. |
| `api_url` | `"https://app.daytona.io/api"` | The Daytona API URL. |
| `target` | the organization's default | The Daytona region sandboxes are created in. |
| `snapshot` | unset | A Docker-capable snapshot in your organization to boot instead of the host image. |
| `base_image` | `"daytonaio/sandbox:0.9.0"` | The Debian or Ubuntu image the host image is built on. Not with `snapshot`. |
| `egress_hosts` | `[]` | Extra hostnames every restricted sandbox may reach, e.g. `["*.internal.example"]`. |

## Examples

**A shared deployment.** The key comes from the secret store, sandboxes go to one region, and cost is grouped
by attribution:

```toml
[sandbox]
default       = "daytona"
agent_default = "daytona"
attribution   = { team = "env-pod", project_id = "env:PROJECT_ID?unassigned" }

[sandbox.providers.daytona.config]
api_key = "secret:daytona_api_key"
target  = "us"
```

**A pre-built snapshot.** Boot a Docker-capable snapshot you maintain instead of the built-in host image:

```toml
[sandbox.providers.daytona.config]
api_key  = "env:DAYTONA_API_KEY"
snapshot = "my-agentenv-docker"
```

**A sandbox with restricted egress.** In a task, `deploy_sandbox` and `deploy_agent` take a `network_policy`;
Daytona enforces it for the sandbox and every container in it:

```json
{"id": "box", "type": "deploy_sandbox", "sandbox_name": "box", "sandbox_mode": "vm", "sandbox_type": "daytona",
 "network_policy": {"mode": "allowlist", "allow_hosts": ["pypi.org", "*.github.com"]}}
```

**A fallback chain.** Try Daytona first and fall back to another provider when a sandbox can't be created:

```toml
[sandbox]
default = "daytona,e2b"
```

**From Python.** Build the configured provider and create a VM directly:

```python
import asyncio

from agent_env.providers.sandbox_providers.sandbox_provider import build_sandbox_provider


async def main() -> None:
    provider = build_sandbox_provider("daytona")
    sandbox = await provider.create_vm(cpu=2, memory=4096, exposed_ports=[8080], timeout=900)
    try:
        print(await sandbox.exec_with_output("sudo", "docker", "info", "--format", "{{.ServerVersion}}"))
        print(sandbox.tunnel_urls[8080])   # https://8080-<sandbox-id>.<preview domain>
    finally:
        await sandbox.terminate()


asyncio.run(main())
```

## The host image

Sandboxes boot from a Docker host image the provider defines in code: `base_image` with Docker Engine, the
Compose v2 plugin and a passwordless-sudo `daytona` user added. Daytona builds it the first time a sandbox asks
for it and caches it as a snapshot in your organization, so nothing is hosted outside Daytona and later
sandboxes start from the cache in about a second. Docker's storage is left empty so the daemon prepares it at
boot; the provider starts `dockerd` and waits for it (up to 180 seconds) before handing the sandbox over.

With `snapshot`, the provider boots that snapshot instead. It must ship Docker Engine and the Compose v2
plugin, with `/var/lib/docker` empty, and a user with passwordless sudo. Sandbox class follows the snapshot, so a
Linux VM snapshot (created from an image reference, as Daytona requires for that class) gives VM sandboxes with
no change here.

## Resources and lifetime

- **Size:** CPU, memory and disk follow the request, rounded up to whole vCPUs and GiB and raised to Daytona's
  Docker-in-Docker floor of 2 vCPU, 4 GiB memory and 10 GiB disk. With `snapshot`, the snapshot fixes the size.
- **Lifetime:** the sandbox's `timeout` becomes Daytona's hard time-to-live, in whole minutes. Sandboxes are
  ephemeral: they are deleted when they stop, and never auto-stop on idleness before that.
- **Cleanup:** when a create fails or its caller is cancelled, the provider deletes any sandbox it made, retrying
  through brief Daytona API errors; if Daytona stays unreachable, the sandbox runs until its time-to-live. A
  rate-limited create gets up to 5 attempts with backoff.

## Networking

- **Ports:** each exposed port gets a public URL, `https://<port>-<sandbox-id>.<preview domain>`, which fills
  `tunnel_urls`. Sandboxes are created public, so the URLs need no token, like the other providers' tunnels.
- **Preview domain:** it is read from Daytona, never written down: from the API's `/config` before the first
  restricted sandbox, and from every sandbox's own preview URLs. It differs between organizations and regions
  (e.g. `daytonaproxy01.net`, `daytonaproxy01.eu`) and `/config` only knows the default, so a sandbox's own URL is
  what settles it. Each domain seen is added to every restricted sandbox's allowlist and published in the
  provider's `EGRESS_HOSTS`, so restricted workloads reach each other's ports. As with every AgentEnv platform's
  domain (`*.e2b.app`, `*.modal.host`, …), the wildcard admits any public Daytona sandbox on that domain, not
  only the run's own.
- **Egress:** allow-all, or an allowlist of up to 100 hostnames with `*.` wildcards. Daytona keeps hostnames and
  CIDRs in separate, mutually exclusive lists, and AgentEnv always adds its platforms' hostnames to an
  allowlist, so policies with CIDRs or IP addresses are refused before any sandbox is created. An empty allowlist
  blocks everything.
- **Downloads:** before a restricted sandbox downloads an image tarball or object from a signed URL, that URL's
  host is added to its allowlist, and the download waits (up to 60 seconds) until the host answers. An allowlist
  update Daytona refuses because it is still applying the previous one is retried for a few seconds.
- **Organization tier:** sandbox-level egress lists need a Daytona organization on Tier 3 or above. On Tier 1 and 2
  Daytona refuses them, so a restricted policy fails with a `NetworkPolicyUnsupportedError` quoting Daytona's
  message, and no sandbox is created. Unrestricted sandboxes there get the tier's own policy: Daytona's essential
  services stay reachable (PyPI, GitHub, npm, Docker Hub, public ECR, S3, GCS and the OpenAI API, among others)
  and every other host is blocked, Daytona preview URLs included. So on Tier 1 and 2 an agent in its own sandbox
  can't reach an environment's gateway in another sandbox, or a model endpoint outside that list; tasks that keep
  everything in one sandbox, like `hello`, work.
- **Reconnect:** `get_sandbox` restores the ports, their URLs and the applied egress policy. A policy it can't
  express leaves `network_policy` unknown, and image loading then fails closed.

## Attribution and cost

Each sandbox carries labels: `agentenv.managed=true`, `agentenv.ports`, one `agentenv.attr.<key>` per
attribution value (values slugged, at most 255 characters) and, when it boots from the host image rather than a
`snapshot`, `agentenv.host-image` with the recipe version. Its name is
`ae-<random>-<attribution values>`. The provider logs one `agent_env.daytona_sandbox_started` event per sandbox
with its id, size and attribution. Running sandboxes can be filtered by these labels in the Daytona dashboard or
with `AsyncDaytona.list(ListSandboxesQuery(labels=...))`; deleted ones are no longer listed.

**Cost per label.** Daytona's analytics API reports usage and price per sandbox, deleted ones included:

```bash
curl -H "Authorization: Bearer $DAYTONA_API_KEY" \
  "https://analytics.app.daytona.io/organization/$DAYTONA_ORG_ID/usage/sandbox?from=2026-10-20T00:00:00Z&to=2026-10-23T00:00:00Z"
```

Each row has `sandboxId`, `totalPrice` and CPU, RAM, disk and GPU seconds, but no labels, and these sandboxes are
deleted when they stop, after which Daytona no longer lists them or their labels. To group cost by attribution,
keep the `agent_env.daytona_sandbox_started` events and join their `daytona_sandbox_id` with `sandboxId`. You'll
find your organization ID in the Daytona dashboard.

## Things to know

- **Commands** run as the `daytona` user through one-shot Daytona sessions, which keep stdout and stderr apart;
  AgentEnv's own `sudo` prefixes give root.
- **Uploads** go through Daytona's file API in 4 MiB parts, joined as root and checked against their sha256.
- **No private network:** containers on different sandboxes reach each other through their public URLs.

## Testing

```bash
pip install -e ".[dev]"
pytest                                   # unit tests, no network
DAYTONA_API_KEY=... pytest tests/integration_tests -v
```

The live tests create real sandboxes, delete them, and fail if any are left. The two allowlist tests also need
`DAYTONA_TEST_EGRESS=1` and an organization on Tier 3 or above.

## Development

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/ruff check . && .venv/bin/black --check . && .venv/bin/mypy agentenv_daytona && .venv/bin/pytest
```

## License

Apache-2.0. See [LICENSE](LICENSE).
