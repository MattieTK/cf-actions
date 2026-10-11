---
name: writing-cf-actions-workflows
description: Use when writing, editing or migrating GitHub Actions workflows in a repository that runs jobs on cf-actions Cloudflare-hosted runners (runs-on cf-1cpu, cf-2cpu or cf-4cpu), or when asked to move CI jobs off GitHub-hosted runners onto Cloudflare Containers.
---

# Writing workflows for cf-actions runners

## Overview

cf-actions starts a fresh Cloudflare container per job, running GitHub's own runner for that one job. A job opts in with `runs-on`. Secrets, `GITHUB_TOKEN` and OIDC work as on GitHub-hosted runners. Docker is available, but containers share the host network.

## Labels

Use exactly one of these, on its own or with `self-hosted`, `linux` or `x64`. Any other label (for example `cf-actions` or `cloudflare`) matches no runner, and the job waits forever.

| Label | Machine | Typical use |
|---|---|---|
| `cf-1cpu` | 1 vCPU, 6 GiB, 12 GB disk | Light scripts. Costs about the same as `ubuntu-slim` |
| `cf-2cpu` | 2 vCPU, 8 GiB, 16 GB disk | Default for lint, unit tests, builds (replaces `ubuntu-latest`) |
| `cf-4cpu` | 4 vCPU, 12 GiB, 20 GB disk | Heavier tests, browsers, Docker builds |

## Keep these jobs on GitHub-hosted runners

- arm64 (`*-arm`), macOS and Windows.
- More than 4 vCPU, 12 GiB RAM or 20 GB disk (larger runners such as `ubuntu-latest-16-cores`).
- Any job in a public repository. cf-actions refuses public repos by default, and GitHub-hosted runners are free there.

In a matrix that mixes these, add a `runner` key per entry with `include:`. Matching entries keep their names, so required status checks still match.

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, ubuntu-24.04-arm, macos-latest]
    include:
      - { os: ubuntu-latest, runner: cf-2cpu }
      - { os: ubuntu-24.04-arm, runner: ubuntu-24.04-arm }
      - { os: macos-latest, runner: macos-latest }
runs-on: ${{ matrix.runner }}
```

## What the image has

- Ubuntu 24.04, user `runner` with passwordless `sudo`, and `apt`.
- git, `gh`, curl, jq, build-essential, Python 3 and a Docker daemon.
- Nothing else is preinstalled. Use `setup-node`, `setup-python`, `setup-go` and similar actions. `playwright install --with-deps` works.

## Docker: services and container jobs

`services:`, `container:`, Docker actions and `docker run` all work. Every container shares the host network, which changes addressing:

- **Reach services at `localhost:<container port>`**, both from steps on the runner and from inside a `container:` job.
- **Service hostnames such as `postgres` do not resolve.** Replace them with `localhost`.
- **Port remapping is ignored.** `5433:5432` still listens on 5432. Two services cannot use the same port.
- **Keep `services:`.** Do not replace them with apt installs.

```yaml
test:
  runs-on: cf-2cpu
  container: node:22                # fine
  services:
    postgres:
      image: postgres:16
      env: { POSTGRES_PASSWORD: postgres }
      options: --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10
    redis:
      image: redis:7
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres   # not @postgres
    REDIS_URL: redis://localhost:6379                                    # not redis://redis
```

## Docker builds

`docker build` works. `docker/setup-buildx-action` defaults to a BuildKit container that has no network access here, so use the `docker` driver:

```yaml
- uses: docker/setup-buildx-action@v3
  with: { driver: docker }
- uses: docker/build-push-action@v6
  with: { context: ., push: false, tags: app:ci }
```

The `docker` driver cannot export cache to `type=gha`. Drop `cache-from`/`cache-to: type=gha`, or keep that job on GitHub-hosted runners if the cache matters. Docker Compose services need `network_mode: host`.

## Switching back without editing workflows

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
```

Set the repository variable `CI_RUNNER` to `cf-2cpu` to move jobs onto Cloudflare, and delete it to move them back.

## When a job sits on "Waiting for a runner"

1. The label is not exactly `cf-1cpu`, `cf-2cpu` or `cf-4cpu`.
2. The repository is public, or the cf-actions GitHub App is not installed on it.
3. Every container of that size is busy. Jobs wait and are retried for up to 3 hours.

The cf-actions status page (the Worker's `/` URL) lists every launch, with any error.
