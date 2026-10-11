#!/usr/bin/env bash
# Docker CLI wrapper for Cloudflare Containers. Installed as /usr/local/bin/docker so it sits
# in front of the real CLI on PATH, for both workflow steps and the GitHub runner itself.
#
# Cloudflare Containers do not allow iptables manipulation, so Docker's bridge networks cannot
# route traffic and containers have to share the host's network. GitHub's runner creates a
# bridge network per job for `services:` and `container:`, and most `docker run`/`docker build`
# commands assume bridge networking, so this wrapper:
#   - turns `docker network create/rm github_network_*` into no-ops
#   - rewrites `--network github_network_*` to `--network host` and drops `--network-alias`
#   - adds `--network host` to run/create commands that don't choose a network
#   - adds `--network host` to builds on the built-in `docker` buildx driver
# Services are then reachable on localhost:<container port>. Port remapping (5433:5432) and
# service hostnames inside `container:` jobs do not work in this mode.
#
# Set CF_DOCKER_HOST_NETWORK=0 to bypass all of this.
set -euo pipefail

real_docker="${CF_REAL_DOCKER:-/usr/bin/docker}"

if [[ "${CF_DOCKER_HOST_NETWORK:-1}" == "0" ]]; then
  exec "$real_docker" "$@"
fi

args=("$@")
n=${#args[@]}

# Skip global options (--config DIR, -H host, ...) to find the subcommand.
i=0
while ((i < n)); do
  case "${args[i]}" in
    --config | -H | --host | --context | -c | -l | --log-level | --tlscacert | --tlscert | --tlskey)
      i=$((i + 2))
      ;;
    -*) i=$((i + 1)) ;;
    *) break ;;
  esac
done
global=("${args[@]:0:i}")
rest=("${args[@]:i}")

is_job_network() { [[ "$1" == github_network_* ]]; }

# Flags of `docker run/create` that take no value. Everything else that starts with `-` and has
# no `=value` consumes the next argument. Needed to find where the image name starts, because
# arguments after the image belong to the container's command and must not be touched.
is_bool_long() {
  case "$1" in
    --detach | --interactive | --tty | --rm | --init | --privileged | --read-only | --publish-all | \
      --oom-kill-disable | --no-healthcheck | --quiet | --help | --disable-content-trust | \
      --sig-proxy | --use-api-socket) return 0 ;;
    *) return 1 ;;
  esac
}

# Short flags: d, i, t, P, q are booleans and can be combined (-it, -dit). Any other letter takes
# a value, either attached (-eFOO=1) or as the next argument when it is the last letter (-e FOO).
# Prints "1" when the flag consumes the next argument.
short_consumes_next() {
  local letters="${1#-}" k c
  for ((k = 0; k < ${#letters}; k++)); do
    c="${letters:k:1}"
    case "$c" in
      d | i | t | P | q) continue ;;
      *)
        if ((k == ${#letters} - 1)); then echo 1; else echo 0; fi
        return
        ;;
    esac
  done
  echo 0
}

rewrite_run() {
  local skip=$1
  local head=("${rest[@]:0:skip}")
  local items=("${rest[@]:skip}")
  local m=${#items[@]}
  local opts=() aliases=() network_set=0 force_host=0 j=0 a v

  while ((j < m)); do
    a="${items[j]}"
    case "$a" in
      --network=* | --net=*)
        network_set=1
        v="${a#*=}"
        if is_job_network "$v"; then
          force_host=1
          opts+=(--network host)
        else
          opts+=("$a")
        fi
        ;;
      --network | --net)
        network_set=1
        v="${items[j + 1]:-}"
        j=$((j + 1))
        if is_job_network "$v"; then
          force_host=1
          opts+=(--network host)
        else
          opts+=("$a" "$v")
        fi
        ;;
      --network-alias=* | --net-alias=*) aliases+=("$a") ;;
      --network-alias | --net-alias)
        aliases+=("$a" "${items[j + 1]:-}")
        j=$((j + 1))
        ;;
      --*=*) opts+=("$a") ;;
      --*)
        if is_bool_long "$a"; then
          opts+=("$a")
        else
          opts+=("$a" "${items[j + 1]:-}")
          j=$((j + 1))
        fi
        ;;
      -?*)
        if [[ "$(short_consumes_next "$a")" == 1 ]]; then
          opts+=("$a" "${items[j + 1]:-}")
          j=$((j + 1))
        else
          opts+=("$a")
        fi
        ;;
      *) break ;;
    esac
    j=$((j + 1))
  done

  if ((network_set == 0)); then
    force_host=1
    opts=(--network host "${opts[@]}")
  fi
  # Network aliases are only valid on user-defined networks; keep them if the caller chose one.
  if ((force_host == 0)); then
    opts+=("${aliases[@]}")
  fi

  exec "$real_docker" "${global[@]}" "${head[@]}" "${opts[@]}" "${items[@]:j}"
}

# The builder a build will use: --builder on the command line, then BUILDX_BUILDER, then the
# current default (empty name).
selected_builder() {
  local k
  for ((k = 0; k < ${#rest[@]}; k++)); do
    case "${rest[k]}" in
      --builder=*) echo "${rest[k]#--builder=}" && return ;;
      --builder) echo "${rest[k + 1]:-}" && return ;;
    esac
  done
  echo "${BUILDX_BUILDER:-}"
}

builder_uses_docker_driver() {
  local info builder
  builder="$(selected_builder)"
  # No buildx at all means the legacy builder, which accepts --network host.
  if [[ -n "$builder" ]]; then
    info="$("$real_docker" "${global[@]}" buildx inspect "$builder" 2>/dev/null)" || return 0
  else
    info="$("$real_docker" "${global[@]}" buildx inspect 2>/dev/null)" || return 0
  fi
  grep -Eq '^Driver:[[:space:]]+docker$' <<<"$info"
}

rewrite_build() {
  local skip=$1 a
  for a in "${rest[@]}"; do
    if [[ "$a" == --network || "$a" == --network=* ]]; then
      exec "$real_docker" "${args[@]}"
    fi
  done
  # The docker-container driver (e.g. from docker/setup-buildx-action) rejects --network host
  # unless the network.host entitlement is allowed, so only add it for the built-in driver.
  if builder_uses_docker_driver; then
    exec "$real_docker" "${global[@]}" "${rest[@]:0:skip}" --network host "${rest[@]:skip}"
  fi
  exec "$real_docker" "${args[@]}"
}

cmd="${rest[0]:-}"
sub="${rest[1]:-}"

case "$cmd" in
  network)
    case "$sub" in
      create)
        name="${rest[${#rest[@]} - 1]}"
        if is_job_network "$name"; then
          echo "$name"
          exit 0
        fi
        ;;
      rm | remove)
        names=()
        for a in "${rest[@]:2}"; do
          [[ "$a" == -* ]] || names+=("$a")
        done
        all_job=$((${#names[@]} > 0))
        for a in "${names[@]}"; do
          is_job_network "$a" || all_job=0
        done
        if ((all_job)); then
          printf '%s\n' "${names[@]}"
          exit 0
        fi
        ;;
    esac
    ;;
  run | create) rewrite_run 1 ;;
  container)
    case "$sub" in
      run | create) rewrite_run 2 ;;
    esac
    ;;
  build) rewrite_build 1 ;;
  image | buildx | builder)
    if [[ "$sub" == build ]]; then
      rewrite_build 2
    fi
    ;;
esac

exec "$real_docker" "$@"
