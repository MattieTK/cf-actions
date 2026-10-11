# Slim GitHub Actions runner image for Cloudflare Containers.
#
# Deliberately much smaller than GitHub's ubuntu-latest image (~60 GB): the largest Cloudflare
# container has a 20 GB disk, and image size affects cold starts. Jobs that need toolchains
# (Node, Python versions, Go, Java, ...) install them with the usual setup-* actions, which
# cache into RUNNER_TOOL_CACHE for the lifetime of the container.
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# Keep in step with https://github.com/actions/runner/releases. GitHub stops sending jobs to
# runners more than 30 days out of date; the runner self-updates when it can, at the cost of
# a slower start, so redeploying periodically keeps start-up fast.
ARG RUNNER_VERSION=2.338.0
ARG RUNNER_SHA256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32

# Tools most workflows assume exist on a GitHub-hosted Ubuntu runner.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git git-lfs gnupg iproute2 jq locales lsb-release \
      openssh-client pkg-config procps python3 python3-pip python3-venv rsync sudo tar tzdata \
      unzip util-linux wget xz-utils zip zstd \
 && locale-gen en_US.UTF-8 \
 && rm -rf /var/lib/apt/lists/*

# Docker Engine, for `services:`, `container:` jobs, Docker-based actions and `docker build`.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      containerd.io docker-buildx-plugin docker-ce docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI: preinstalled on GitHub-hosted runners and assumed by many workflows.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Same user name and uid as GitHub-hosted runners, with passwordless sudo.
RUN useradd --create-home --uid 1001 --shell /bin/bash runner \
 && usermod -aG docker runner \
 && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner

WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c - \
 && tar xzf runner.tar.gz \
 && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/hostedtoolcache \
 && chown -R runner:runner /home/runner /opt/hostedtoolcache

# RUNNER_MANUALLY_TRAP_SIG makes run.sh forward SIGTERM/SIGINT to the runner's process group and
# return the runner's real exit code. Without it, a stop orphans the listener and the job is
# never reported as cancelled. The deprecated-version exit code (7) lets the Worker report a runner
# that GitHub rejects as too old; the runner maps nearly every other outcome to exit code 0.
ENV LANG=en_US.UTF-8 \
    RUNNER_MANUALLY_TRAP_SIG=1 \
    ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1 \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    ImageOS=ubuntu24 \
    ImageVersion=cf-actions

COPY --chmod=0755 docker-wrapper.sh /usr/local/bin/docker
COPY --chmod=0755 entrypoint.sh /usr/local/bin/cf-runner-entrypoint

ENTRYPOINT ["/usr/local/bin/cf-runner-entrypoint"]
