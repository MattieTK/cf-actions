import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPER = join(__dirname, "..", "container", "docker-wrapper.sh");

// Stands in for /usr/bin/docker: prints each argument on its own line, and answers
// `buildx inspect` with the driver named in FAKE_DRIVER.
const fakeDocker = join(mkdtempSync(join(tmpdir(), "cf-docker-")), "docker");
writeFileSync(
	fakeDocker,
	`#!/usr/bin/env bash
if [[ "$1" == buildx && "$2" == inspect ]]; then
  if [[ "\${3:-}" == ctr ]]; then printf 'Name: ctr\\nDriver: docker-container\\n'; exit 0; fi
  [[ -n "\${FAKE_DRIVER:-}" ]] || exit 1
  printf 'Name: default\\nDriver: %s\\n' "$FAKE_DRIVER"
  exit 0
fi
printf '%s\\n' "$@"
`,
);
chmodSync(fakeDocker, 0o755);

function docker(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync("bash", [WRAPPER, ...args], {
		env: { PATH: process.env.PATH, CF_REAL_DOCKER: fakeDocker, ...env },
		encoding: "utf8",
	});
	return { status: result.status, args: result.stdout.split("\n").filter(Boolean), stderr: result.stderr };
}

describe("docker wrapper", () => {
	it("turns job network creation and removal into no-ops", () => {
		expect(docker(["network", "create", "--label", "abc", "github_network_123"]).args).toEqual(["github_network_123"]);
		expect(docker(["network", "rm", "github_network_123"]).args).toEqual(["github_network_123"]);
	});

	it("passes other network commands through", () => {
		expect(docker(["network", "create", "mynet"]).args).toEqual(["network", "create", "mynet"]);
		expect(docker(["network", "rm", "github_network_1", "mynet"]).args).toEqual(["network", "rm", "github_network_1", "mynet"]);
	});

	it("moves runner service containers onto the host network and drops aliases", () => {
		const { args } = docker([
			"create",
			"--name",
			"svc",
			"--label",
			"x",
			"--network",
			"github_network_123",
			"--network-alias",
			"postgres",
			"-p",
			"5432:5432",
			"-e",
			"POSTGRES_PASSWORD=pw",
			"postgres:16",
		]);
		expect(args).toEqual([
			"create",
			"--name",
			"svc",
			"--label",
			"x",
			"--network",
			"host",
			"-p",
			"5432:5432",
			"-e",
			"POSTGRES_PASSWORD=pw",
			"postgres:16",
		]);
	});

	it("adds host networking to plain docker run without touching the container command", () => {
		const { args } = docker(["run", "--rm", "-it", "-v", "/a:/b", "alpine", "sh", "-c", "echo --network x"]);
		expect(args).toEqual(["run", "--network", "host", "--rm", "-it", "-v", "/a:/b", "alpine", "sh", "-c", "echo --network x"]);
	});

	it("handles the --flag=value form and container run", () => {
		const { args } = docker(["container", "run", "--network=github_network_9", "--network-alias=redis", "redis:7"]);
		expect(args).toEqual(["container", "run", "--network", "host", "redis:7"]);
	});

	it("respects an explicit non-job network and keeps its aliases", () => {
		const { args } = docker(["run", "--network", "none", "--network-alias", "a", "alpine"]);
		expect(args).toEqual(["run", "--network", "none", "--network-alias", "a", "alpine"]);
	});

	it("keeps global options in front of the subcommand", () => {
		const { args } = docker(["--config", "/tmp/cfg", "run", "alpine"]);
		expect(args).toEqual(["--config", "/tmp/cfg", "run", "--network", "host", "alpine"]);
	});

	it("adds host networking to builds on the built-in docker driver only", () => {
		expect(docker(["build", "-t", "img", "."], { FAKE_DRIVER: "docker" }).args).toEqual([
			"build",
			"--network",
			"host",
			"-t",
			"img",
			".",
		]);
		expect(docker(["buildx", "build", "."], { FAKE_DRIVER: "docker-container" }).args).toEqual(["buildx", "build", "."]);
		expect(docker(["build", "--network=none", "."], { FAKE_DRIVER: "docker" }).args).toEqual(["build", "--network=none", "."]);
	});

	it("checks the builder a build actually targets", () => {
		expect(docker(["buildx", "build", "--builder", "ctr", "."], { FAKE_DRIVER: "docker" }).args).toEqual([
			"buildx",
			"build",
			"--builder",
			"ctr",
			".",
		]);
		expect(docker(["build", "."], { FAKE_DRIVER: "docker", BUILDX_BUILDER: "ctr" }).args).toEqual(["build", "."]);
	});

	it("uses host networking for the legacy builder when buildx is missing", () => {
		expect(docker(["image", "build", "."]).args).toEqual(["image", "build", "--network", "host", "."]);
	});

	it("can be switched off", () => {
		expect(docker(["run", "alpine"], { CF_DOCKER_HOST_NETWORK: "0" }).args).toEqual(["run", "alpine"]);
	});

	it("passes unrelated commands through unchanged", () => {
		expect(docker(["ps", "-a"]).args).toEqual(["ps", "-a"]);
		expect(docker(["version"]).args).toEqual(["version"]);
	});
});
