# cf-actions – GitHub Actions jobs on Cloudflare Containers

Status: draft, written 11 October 2026. Implementation started on the same day.

## Problem

GitHub-hosted runners cost $0.006/min (2 vCPU) and $0.012/min (4 vCPU) on private repos. Every job is rounded up to a whole minute. Most CI jobs spend much of their time waiting on the network or disk, but GitHub bills the whole machine for the whole minute.

Since November 2025, Cloudflare Containers bill CPU only while it is in use. Memory and disk are billed at their provisioned size. Billing is per 10 ms. With published rates, an equivalent 2 vCPU / 8 GiB container costs about $0.0037/min with the CPU fully busy, and about $0.0020/min at 30% CPU. A 4 vCPU / 12 GiB container costs about $0.0067/min and $0.0033/min respectively.

We want anyone to be able to deploy a Worker into their own Cloudflare account and send selected GitHub Actions jobs to it. Jobs should get the same secrets and tokens they have on GitHub-hosted runners.

## Goals

- Install from a single "Deploy to Cloudflare" button. A GitHub App is then created from the deployed Worker, so its private key never leaves the installer's account.
- Workflows opt in per job: `runs-on: cf-1cpu | cf-2cpu | cf-4cpu`.
- One container per job, running GitHub's own runner with a just-in-time (JIT) single-use registration.
- Secrets, `GITHUB_TOKEN` and OIDC work as normal. The runner receives them from GitHub directly, so we never handle job secrets.
- Recover from missed webhooks, containers that never get a job, and containers that run too long.
- Show a status page with recent jobs and an estimated cost, next to what GitHub would have charged.

## Non-goals (for now)

- **Machines larger than 4 vCPU / 12 GiB / 20 GB.** That is Cloudflare's current maximum.
- **arm64.** Cloudflare Containers are amd64 only.
- **Public repos.** They are refused by default. GitHub-hosted runners are free for public repos, and self-hosted runners on public repos let anyone who can open a PR run code. An opt-in flag exists.
- **Transparent rerouting of `ubuntu-latest`.** GitHub always sends that label to its own runners.
- **Docker Compose networks, rootless Docker, and service hostname resolution inside `container:` jobs.** See "Docker" below.
- **GitHub's scale set listener protocol (`actions/scaleset`).** It is still in preview. It is a candidate replacement for webhooks later.
- **Caching beyond what `actions/cache` already gives.** That action talks to GitHub's cache service, which works from self-hosted runners.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Build on an existing community project or start fresh? | Start fresh, informed by biw/cloudflare-github-actions-runner and k2wanko/cloudflare-github-self-hosted-runner. |
| What goes in the runner image? | A slim Ubuntu 24.04 base with Docker, around 1.5–2.5 GB. |
| Which account types are supported? | Both organisations and personal accounts. |
| Which orchestration approach? | Webhooks, plus one Durable Object per job, plus a cron backstop. |

## Architecture

```
GitHub ──webhook──▶ Worker
                     ├─ POST /webhook   verify HMAC → route by label → JobLedger + Runner DO
                     ├─ /setup          GitHub App manifest flow (admin only)
                     └─ /               status page (admin only)
                     │
                     ├──▶ Runner1Cpu / Runner2Cpu / Runner4Cpu  (Container DO, one per job)
                     ├──▶ AppRegistry DO  (singleton: GitHub App credentials, encrypted)
                     ├──▶ JobLedger DO    (singleton: one row per runner, for status + backstop)
                     └─ cron (every minute): redeliver failed webhooks, re-drive stuck launches,
                        reconcile runners whose stop was never recorded
```

### Container classes and sizes

Cloudflare fixes the instance type per container application, so there is one class per size. All three classes use the same image.

| Label | Class | Instance type | vCPU | Memory | Disk | GitHub comparison |
|---|---|---|---|---|---|---|
| `cf-1cpu` | Runner1Cpu | standard-2 | 1 | 6 GiB | 12 GB | `ubuntu-slim` at $0.002/min |
| `cf-2cpu` | Runner2Cpu | standard-3 | 2 | 8 GiB | 16 GB | 2-core at $0.006/min |
| `cf-4cpu` | Runner4Cpu | standard-4 | 4 | 12 GiB | 20 GB | 4-core at $0.012/min |

`cf-1cpu` is unlikely to save money against `ubuntu-slim` when the CPU is busy. It still exists because `ubuntu-slim` cannot run Docker.

### Routing

The runner registers with the labels `self-hosted`, `Linux`, `X64` and one size label. We accept a job only when all of the following hold:

- Its labels contain exactly one of our size labels.
- Every other label is one of `self-hosted`, `linux` or `x64` (compared case-insensitively).
- The repository is private, unless `ALLOW_PUBLIC_REPOS` is set.
- The owner is in `ALLOWED_OWNERS`, if that variable is set.

Anything else is ignored.

### Job lifecycle

1. The `workflow_job.queued` webhook arrives. The Worker verifies the signature using the secret of the App named in the `X-GitHub-Hook-Installation-Target-ID` header. It routes by label and inserts a ledger row keyed by runner name `cf-<size>-<jobId>`. The insert is idempotent. The Worker returns 202 and starts the launch with `waitUntil`.
2. **Launch** happens in the Runner DO named `job-<jobId>`. Because the DO is keyed by job ID, duplicate webhooks are harmless. The launch:
   - mints an installation token;
   - calls `generate-jitconfig` (the org endpoint for organisations, the repo endpoint for personal accounts, using `RUNNER_GROUP_ID`, default 1);
   - starts the container with `JIT_CONFIG` in its environment;
   - stores the runner ID and deadlines.
3. **Inside the container**, the entrypoint starts `dockerd` (with iptables and IP forwarding off), waits for it, then runs `./run.sh --jitconfig` as the unprivileged `runner` user. That user has passwordless sudo and is in the docker group. The runner exits after one job, and so does the container.
4. **`workflow_job.in_progress`** records which runner took the job. GitHub can hand a job to any idle runner with matching labels, so this may not be the runner started for it. The ledger is therefore keyed by runner, not by job.
5. **`workflow_job.completed`** records the conclusion and the job duration, which feeds the GitHub cost comparison.
6. **`onStop`** in the Runner DO records the exit code and stop time.

### Watchdog (inside each Runner DO)

The `Container` base class runs an alarm loop while the container is alive and calls `onActivityExpired()` after each `sleepAfter` window. We set `sleepAfter` to 2 minutes and override that hook as a watchdog:

- **Max runtime.** If the container has run longer than `MAX_JOB_MINUTES` (default 360), stop it.
- **Idle.** If no job has been assigned after `IDLE_TIMEOUT_MINUTES` (default 10), ask GitHub whether the runner is busy before doing anything. This guards against a missed `in_progress` webhook killing a working runner.
  - If the runner is busy, mark it assigned.
  - Otherwise, stop the container and delete the runner registration.

### Cron backstop (every minute)

- For each registered App, list webhook deliveries since the last check. Redeliver failed `workflow_job` deliveries that have not since succeeded.
- Ledger rows still `pending` more than 2 minutes after creation are re-driven. The launch is idempotent.
- Rows `running` beyond `MAX_JOB_MINUTES + 20` minutes are reconciled against `getState()`.

### Install flow

1. Click "Deploy to Cloudflare". Cloudflare clones the repo into the installer's GitHub account, builds the image and deploys the Worker. It prompts for `ADMIN_TOKEN` and `ENCRYPTION_KEY`.
2. Open `https://<worker>/setup` and sign in with HTTP basic auth (any username, password `ADMIN_TOKEN`). Choose personal account or organisation. The Worker posts a GitHub App manifest to GitHub:
   - Personal accounts get `administration: write`, `actions: read` and `metadata: read`.
   - Organisations get `organization_self_hosted_runners: write`, `actions: read` and `metadata: read`.
   - Either way the App subscribes to `workflow_job`, and it is **private**, so it can only be installed on the account that owns it.
3. GitHub redirects to `/setup/callback`. The Worker exchanges the code for App credentials, encrypts them with AES-GCM using `ENCRYPTION_KEY`, and stores them in AppRegistry.
4. Install the App on the repos or organisation.
5. Change `runs-on`.

Several Apps can be registered with one deployment, for example a personal account and two organisations.

### Docker

Cloudflare Containers do not allow iptables manipulation, so Docker networks cannot do NAT and containers need `--network=host`. GitHub's runner creates a bridge network per job for `services:` and `container:`. A `docker` wrapper on `PATH` therefore:

- turns `network create/rm` for `github_network_*` into no-ops;
- rewrites `--network github_network_*` to `--network host` and drops `--network-alias`;
- adds `--network host` to `run`, `create` and `build` when no network is given.

The result is that services such as Postgres are reachable on `localhost:<container port>`. That is how most workflows already address them when steps run on the host. Port remapping (`5433:5432`) and service hostnames inside `container:` jobs do not work. The wrapper can be turned off with `CF_DOCKER_HOST_NETWORK=0`.

This is the least certain part of the design. It must be checked on real Cloudflare infrastructure.

### Security

- Webhooks are verified with HMAC-SHA256, using a constant-time comparison.
- `/setup` and `/` require HTTP basic auth with `ADMIN_TOKEN`, compared in constant time.
- The setup `state` parameter is single-use and expires after 1 hour.
- The App is private. Jobs are filtered by `ALLOWED_OWNERS` and by repository visibility.
- App credentials are encrypted at rest with a key that exists only as a Worker secret. DO storage can be browsed in the dashboard, but secrets cannot.
- The JIT config is passed only as a container environment variable and is never logged.

## Changes after code review (11 October 2026)

An independent review found several problems in the first implementation. They are fixed as follows:

- **Signal handling.** The image sets `RUNNER_MANUALLY_TRAP_SIG=1`. Without it, `run.sh` does not forward signals, and a stop orphans the listener. The entrypoint now installs its trap before starting dockerd.
- **Ledger before state.** The ledger is written before the Durable Object's phase changes, so a failed ledger write is retried by the next `onStop`, launch or reconcile. Before, a failed write could leave a row stuck at `running`.
- **Failed starts.** A container that exits while still `launching` leaves the phase as `launching`, so the backstop retries the launch.
- **Unrecorded containers.** A container found running without a recorded `running` phase is adopted, never replaced, because its runner may already be on a job.
- **Retry limit.** Launch retries are limited by time, not attempt count. The backstop retries with backoff (1, 2, 4, 8, then 15 minutes) for up to 3 hours. Before, capacity errors used up three attempts in about four minutes.
- **Runner names.** A runner name already taken by an untracked registration is resolved by looking the registration up by name and deleting it.
- **Repository runner groups.** Repository runners always use group 1.
- **Webhook redelivery.** Redelivery follows pagination back to the 30-minute window.
- **GitHub CLI.** `gh` is installed in the image.

## Deployment with `cf` (11 October 2026)

The project uses `cf`, the Cloudflare CLI (beta), instead of Wrangler. `cloudflare.config.ts` replaces `wrangler.jsonc`:

- **Containers.** The three runner sizes are `defineContainer` entries, attached to their Durable Object classes through `exports.durableObject({ storage: "sqlite", container })`.
- **Durable Object migrations.** Wrangler's tagged migrations are replaced by `cf`'s `exports` lifecycle declarations.
- **Secrets.** `ADMIN_TOKEN` and `ENCRYPTION_KEY` are declared with `bindings.secret()` and uploaded with `cf deploy --secrets-file`.
- **Types.** Worker types come from `cf workers types`. Durable Object bindings that name their own Worker by string are untyped there, so `src/env.d.ts` narrows them.
- **Push-to-deploy.** The Workers Builds trigger runs `pnpm cf deploy`.

For JavaScript Workers, `cf` still delegates bundling to Wrangler internally, so `wrangler` remains a dev dependency. The Vitest Workers integration also still needs a Wrangler config, so `test/workers/wrangler.jsonc` remains.

## Risks and assumptions

- **Docker networking** needs checking on Cloudflare (see "Docker" above).
- **Deploys can interrupt jobs.** A deploy rolls containers to the new image. We set `rollout_active_grace_period` to 6 hours so running instances are not replaced mid-job, assuming the platform accepts that value. The README recommends `--containers-rollout=none` for Worker-only changes.
- **No guaranteed runtime.** Cloudflare can stop an instance at any time, with SIGTERM and up to 15 minutes' grace. The entrypoint forwards SIGTERM to the runner. The job will fail, and GitHub's normal re-run applies.
- **Assumed:** passing `self-hosted`, `Linux` and `X64` explicitly in JIT labels is accepted. GitHub's own example does this.
- **Assumed:** the Deploy to Cloudflare button builds and deploys container images.
- **The runner version goes stale.** GitHub refuses runners more than 30 days out of date. The runner's auto-update is left on, so an old image updates itself at the cost of slower starts. Redeploying refreshes the image.
- **Self-hosted fee.** GitHub's postponed $0.002/min fee would change the maths if it returns.

## Testing

- Unit tests with Vitest in Node cover the pure logic: signature verification, label routing, PKCS#1→PKCS#8 conversion and the RS256 JWT, cost estimation, manifest construction, runner-name parsing, the watchdog decision function and the backstop selection.
- Shell tests for the docker wrapper use a fake `docker` binary.
- Build the image locally and check the runner installs and its dependencies resolve.
- A smoke-test workflow in `examples/` exercises checkout, `setup-node`, `docker run` and a Postgres service on `cf-2cpu`. It needs a real deployment.
