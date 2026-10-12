# cf-actions

Run GitHub Actions jobs on Cloudflare Containers in your own Cloudflare account.

You deploy one Worker. It creates a private GitHub App for you, then starts a fresh container for every job that asks for it with `runs-on: cf-2cpu`. The container runs GitHub's own runner for exactly one job and exits. Secrets, `GITHUB_TOKEN` and OIDC work exactly as on GitHub-hosted runners, because GitHub hands them to the runner directly.

> **Status: early.** It has run real CI for a handful of private repositories since October 2026, and most of the behaviour it depends on has been tested on Cloudflare (see [Tested on Cloudflare](#tested-on-cloudflare)). A few things still have not (see [Known unknowns](#known-unknowns)).

## When this saves money

Cloudflare bills CPU only while it is busy, memory and disk for the whole time the container runs, all per 10 ms. GitHub bills the whole machine and rounds every job up to a whole minute. With published prices (October 2026):

| Size | Cloudflare instance | GitHub equivalent | GitHub per min | Cloudflare per min, CPU always busy | Cloudflare per min, CPU 30% busy |
|---|---|---|---|---|---|
| `cf-1cpu` | 1 vCPU, 6 GiB, 12 GB | `ubuntu-slim` | $0.002 | ~$0.0021 | ~$0.0013 |
| `cf-2cpu` | 2 vCPU, 8 GiB, 16 GB | Linux 2-core | $0.006 | ~$0.0037 | ~$0.0020 |
| `cf-4cpu` | 4 vCPU, 12 GiB, 20 GB | Linux 4-core | $0.012 | ~$0.0067 | ~$0.0033 |

CI jobs spend a lot of time waiting on downloads and I/O, so real CPU use is usually well under 100%. Short jobs gain the most: a 15-second lint job costs a full minute on GitHub.

It is not worth it when:

- **The repository is public.** GitHub-hosted runners are free for public repos, and self-hosted runners on public repos let anyone who opens a pull request run code on them. Public repos are refused by default.
- **You are within GitHub's included minutes** (2,000–3,000 a month on most plans).
- **A job needs more than 4 vCPU / 12 GiB / 20 GB disk, or arm64.** Cloudflare Containers do not offer either.
- **A job depends heavily on tools preinstalled on `ubuntu-latest`.** This image is about 1.65 GB rather than GitHub's ~60 GB. It includes git, the GitHub CLI, Docker, build-essential and Python 3. Jobs that need other tools spend extra time installing them on every run.

The status page shows, for each job, the most it could have cost on Cloudflare next to what GitHub would have charged, so you can check these numbers against your own workloads.

## How it works

```
GitHub ──workflow_job webhook──▶ Worker ──▶ Runner Durable Object (one per job)
                                   │              └─▶ Container: dockerd + GitHub runner (--jitconfig)
                                   ├──▶ AppRegistry DO (GitHub App credentials, encrypted)
                                   ├──▶ JobLedger DO (history for the status page and the backstop)
                                   └─ cron, every minute: redeliver failed webhooks, retry stuck launches
```

1. A job with `runs-on: cf-2cpu` is queued. GitHub sends a `workflow_job` webhook to the Worker.
2. The Worker checks the signature and the labels. It then asks GitHub for a single-use ("just-in-time") runner registration and starts a container with it.
3. The runner picks up the job, runs it and exits, and the container stops with it.
4. A watchdog in each Durable Object stops containers that never get a job (after 10 minutes, once GitHub confirms the runner is idle) or that exceed the maximum job time (6 hours).

Missed webhooks are redelivered by the cron backstop, and duplicate deliveries are harmless because each job maps to exactly one Durable Object.

### Jobs that wait for an environment approval

GitHub sends `queued` for a job before its environment approval and again once it is approved, so the Worker cannot tell from the first one that the job has to wait. It launches a runner straight away:

- **Approved within the idle timeout (10 minutes):** that runner picks the job up.
- **Approved later:** the watchdog has already stopped the idle runner. The second `queued` finds it stopped without having run a job, so the Durable Object checks with GitHub that the job is queued and launches a new runner for it, named with an attempt suffix (`cf-2cpu-<job>-2`). If the approval lands while the idle container is still shutting down, the backstop launches the new runner within a few minutes instead.

Each attempt has its own row on the status page, so the idle time of the first runner still counts towards cost. Expect up to 10 minutes of idle container time per approval-gated job.

## Install

You need a Cloudflare account on the Workers Paid plan, which Containers require.

### 1. Deploy the Worker

The project is configured for [`cf`](https://github.com/cloudflare/cf), the Cloudflare CLI, through [`cloudflare.config.ts`](cloudflare.config.ts). `cf` is a dev dependency, so `pnpm cf` runs the pinned version. Deploying builds the container image locally, so Docker must be running.

```bash
pnpm install
```

```bash
pnpm cf auth login
```

Create a secrets file. It is ignored by git. Generate each value with `openssl rand -hex 32`:

- `ADMIN_TOKEN` is the password for the setup and status pages.
- `ENCRYPTION_KEY` encrypts the GitHub App's private key at rest. Do not change it after setup, or the stored key can no longer be read.

```bash
printf 'ADMIN_TOKEN=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .cf-actions-secrets
```

Deploy, uploading the secrets with the first version. Set `CLOUDFLARE_ACCOUNT_ID` if you can reach more than one account:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm cf deploy --secrets-file .cf-actions-secrets
```

Later deploys keep the existing secrets, so `pnpm cf deploy` is enough.

To deploy on every push instead, connect the repository with Workers Builds, either in the dashboard or with `cf builds triggers create`, and set its deploy command to `pnpm cf deploy`.

### 2. Create the GitHub App

Open `https://<your-worker>.workers.dev/setup`. Sign in with any username and your `ADMIN_TOKEN` as the password. Choose your personal account or an organisation, then confirm on GitHub. The Worker stores the new App's credentials and links you to its install page.

The App is private, so only the account that owns it can install it. It asks for the narrowest permissions that work:

| Installed on | Permissions | Runners registered at |
|---|---|---|
| Organisation | Self-hosted runners: write, Actions: read | Organisation (default runner group) |
| Personal account | Administration: write, Actions: read | Each repository |

Personal accounts need `Administration: write` because that is the only permission that lets an App register repository runners. It also grants access to other repository settings, so install the App only on the repositories that need it.

You can create several Apps from one deployment, for example one for your personal account and one per organisation.

### 3. Install the App and change `runs-on`

Install the App on your repositories or organisation, then change the jobs you want to move:

```yaml
jobs:
  test:
    runs-on: cf-2cpu   # or cf-1cpu, cf-4cpu
```

To switch a repository between Cloudflare and GitHub without editing workflows, use a repository variable:

```yaml
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
```

[`examples/smoke-test.yml`](examples/smoke-test.yml) checks checkout, `setup-node`, secrets, OIDC, `docker run`, `docker build` and a Postgres service.

## For coding agents

[`skills/writing-cf-actions-workflows`](skills/writing-cf-actions-workflows/SKILL.md) is an agent skill that teaches coding agents to write workflows for these runners: the labels, which jobs to leave on GitHub, and the Docker networking rules. To make it available to Claude Code in every project, link it into your skills folder:

```bash
ln -s "$PWD/skills/writing-cf-actions-workflows" ~/.claude/skills/writing-cf-actions-workflows
```

Agents that read the cross-tool `~/.agents/skills/` folder can use the same link there.

## Docker in jobs

Each container runs a Docker daemon, so Docker-based actions, `services:`, `container:` jobs and `docker build` are available. Cloudflare Containers do not allow iptables changes, though, so Docker cannot create working bridge networks. A small wrapper around the `docker` command puts containers on the host network instead. In practice:

- **Services are reachable on `localhost` at their own port.** That is how most workflows already address them. Port remapping (`5433:5432`) has no effect, and two services cannot use the same port.
- **Service hostnames (such as `postgres`) do not resolve inside `container:` jobs.** Use `localhost` there too.
- **`docker build` works with the default builder.** With `docker/setup-buildx-action`, use `driver: docker`. Its default `docker-container` driver runs BuildKit on a bridge network with no internet access.
- **Docker Compose** projects need `network_mode: host` on their services.

Set `CF_DOCKER_HOST_NETWORK=0` in a step's environment to bypass the wrapper.

## Configuration

Set these in `env` in [`cloudflare.config.ts`](cloudflare.config.ts):

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_OWNERS` | empty | Comma-separated GitHub owners allowed to use the runners. Empty allows any account the App is installed on. |
| `ALLOW_PUBLIC_REPOS` | `false` | Allow jobs from public repositories. Read the security notes first. |
| `IDLE_TIMEOUT_MINUTES` | `10` | Stop a runner that has not picked up a job after this long. |
| `MAX_JOB_MINUTES` | `360` | Hard limit on a container's lifetime. |
| `RUNNER_GROUP_ID` | `1` | Runner group for organisation runners. By default the group only serves private repos. |

Concurrency per size is limited by `maxInstances` on each container in `cloudflare.config.ts` (10 by default). When every instance of a size is busy, extra jobs wait in GitHub's queue while the backstop retries their launch. Retries back off from 1 minute to 15 minutes and stop after 3 hours, at which point the status page shows the launch as failed and the job stays queued until GitHub's own 24-hour timeout or until you cancel it.

## Security

- Webhooks are verified with the App's secret (HMAC-SHA256). Admin pages use HTTP basic auth with `ADMIN_TOKEN`. Both comparisons run in constant time.
- The App's private key and webhook secret are encrypted (AES-GCM) with `ENCRYPTION_KEY` before they are stored. Durable Object storage can be browsed in the Cloudflare dashboard, but Worker secrets cannot.
- Each job gets a fresh container that is thrown away afterwards, so nothing carries over between jobs.
- Jobs run with passwordless `sudo` and access to the Docker daemon, like GitHub-hosted runners. Anyone who can push a workflow to an enabled repository can run arbitrary code in your Cloudflare account and use its egress.

## Updating

- **Runner version.** GitHub refuses runners more than 30 days out of date. The runner updates itself at start-up when it is behind, which makes jobs start more slowly. Bump `RUNNER_VERSION` and `RUNNER_SHA256` in `container/Dockerfile` and redeploy to keep start-up fast.
- **Deploys and running jobs.** Each container's `rollout.activeGracePeriod` is set so that a deploy does not replace containers that are mid-job. For Worker-only changes, `pnpm cf deploy --containers-rollout=none` skips the image rollout entirely.

## Tested on Cloudflare

Checked against a live deployment on 12 October 2026, with workflows kept in a separate trials repository so they can be re-run after changes:

- **Docker networking.** Services answer on `localhost`, `docker run` and `docker build` reach the internet, a `container:` job reaches a service on `localhost`, buildx works with `driver: docker`, and Docker Compose works with `network_mode: host`. Service hostnames do not resolve, as described in [Docker in jobs](#docker-in-jobs).
- **JIT labels.** A live runner is registered with `self-hosted`, `Linux`, `X64` and its size label, so jobs that list any of those alongside the size label match.
- **Rollout grace period.** A deploy that changed the image while two 20-minute jobs were running left both containers in place, and both jobs finished on the old image. New launches moved to the new image about 7 minutes after the deploy. The full 6 hours has not been tested.
- **Deleting a busy runner.** GitHub refuses with `422` and "Runner … is currently running a job and cannot be deleted", and the job carries on. The idle check relies on this, and treats other 422s (validation errors, rate limiting) as "cannot tell, try again".
- **Environment approvals.** GitHub sends `queued`, then `waiting`, then `queued` again on approval, all for the same job ID. See [Jobs that wait for an environment approval](#jobs-that-wait-for-an-environment-approval).
- **Isolation.** Files and Docker images left by one job were not visible to the next, and each job ran under its own kernel boot.

## Known unknowns

- **`cf` is in beta.** Its commands and the `cloudflare.config.ts` format can still change before the stable release.
- **Rollout grace period beyond 20 minutes.** That the platform keeps a mid-job container for the full 6-hour `rollout.activeGracePeriod`.
- **Relaunch after a late approval, end to end.** The relaunch logic is unit tested and follows the webhook order observed above, but required reviewers need a paid GitHub plan on private repositories, so it has not yet run on a real approval-gated job.

## Development

`pnpm test` runs two Vitest projects. The `unit` project tests the pure logic and the docker wrapper in Node. The `workers` project tests the ledger and App registry Durable Objects against real SQLite in the Workers runtime. It uses its own small Wrangler config in `test/workers/`, because the Vitest integration still reads Wrangler configuration. `pnpm typecheck` regenerates the Worker types with `cf workers types` first.

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
docker build --platform linux/amd64 -t cf-actions-runner:dev container
```

The design and the reasoning behind it are in [`docs/superpowers/specs/2026-10-11-cf-actions-design.md`](docs/superpowers/specs/2026-10-11-cf-actions-design.md).
