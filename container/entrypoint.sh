#!/usr/bin/env bash
# Runs exactly one GitHub Actions job, then exits (which stops the Cloudflare container).
#
# Expects JIT_CONFIG: the encoded just-in-time runner config minted by the Worker.
# Optional CF_DOCKER=0 skips starting the Docker daemon.
set -euo pipefail

if [[ -z "${JIT_CONFIG:-}" ]]; then
  echo "cf-actions: JIT_CONFIG is not set, nothing to run" >&2
  exit 64
fi

# Cloudflare sends SIGTERM (then SIGKILL after up to 15 minutes) when it stops an instance.
# Installed first: bash as PID 1 ignores signals it has no trap for, so a stop during dockerd
# start-up would otherwise be dropped. Once the runner is up, run.sh (with
# RUNNER_MANUALLY_TRAP_SIG=1) passes the signal to the listener so it can report the job.
runner_pid=""
# shellcheck disable=SC2317  # invoked by the trap below
on_signal() {
  if [[ -n "$runner_pid" ]]; then
    kill -TERM "$runner_pid" 2>/dev/null || true
  else
    exit 143
  fi
}
trap on_signal TERM INT

start_dockerd() {
  # Cloudflare Containers do not allow iptables manipulation, so Docker runs without NAT and
  # IP forwarding. The docker wrapper on PATH moves containers onto the host network instead.
  dockerd --iptables=false --ip6tables=false --ip-forward=false >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    if /usr/bin/docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  # Jobs that never touch Docker can still run, so carry on rather than failing the job here.
  echo "cf-actions: dockerd did not become ready, continuing without Docker" >&2
  tail -n 50 /var/log/dockerd.log >&2 || true
}

if [[ "${CF_DOCKER:-1}" != "0" ]]; then
  start_dockerd
fi

jit_config="$JIT_CONFIG"
# Keep the registration credential out of every job step's environment.
unset JIT_CONFIG

cd /home/runner/actions-runner
HOME=/home/runner USER=runner setpriv --reuid=runner --regid=runner --init-groups \
  ./run.sh --jitconfig "$jit_config" &
runner_pid=$!

# `wait` returns early when a trapped signal arrives, so keep waiting for the real exit code.
set +e
wait "$runner_pid"
status=$?
while kill -0 "$runner_pid" 2>/dev/null; do
  wait "$runner_pid"
  status=$?
done
exit "$status"
