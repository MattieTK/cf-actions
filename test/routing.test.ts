import { describe, expect, it } from "vitest";
import { routeJob } from "../src/routing";
import { parseSettings } from "../src/settings";
import { parseRunnerName, runnerNameFor, sizeByLabel } from "../src/sizes";

const settings = parseSettings({});
const privateJob = (labels: string[], owner = "acme") => ({ labels, owner, privateRepo: true });

describe("routeJob", () => {
	it("accepts a single size label", () => {
		const decision = routeJob(privateJob(["cf-2cpu"]), settings);
		expect(decision).toMatchObject({ kind: "accept", size: { label: "cf-2cpu" } });
	});

	it("accepts the generic self-hosted labels alongside a size, in any case", () => {
		const decision = routeJob(privateJob(["self-hosted", "Linux", "x64", "CF-4CPU"]), settings);
		expect(decision).toMatchObject({ kind: "accept", size: { label: "cf-4cpu" } });
	});

	it("ignores GitHub-hosted labels", () => {
		expect(routeJob(privateJob(["ubuntu-latest"]), settings)).toMatchObject({ kind: "ignore" });
	});

	it("ignores jobs that also require labels our runners do not have", () => {
		const decision = routeJob(privateJob(["cf-2cpu", "gpu"]), settings);
		expect(decision).toEqual({ kind: "ignore", reason: "unsupported labels: gpu" });
	});

	it("ignores jobs asking for two sizes", () => {
		expect(routeJob(privateJob(["cf-2cpu", "cf-4cpu"]), settings)).toMatchObject({ kind: "ignore" });
	});

	it("refuses public repositories unless allowed", () => {
		const job = { labels: ["cf-2cpu"], owner: "acme", privateRepo: false };
		expect(routeJob(job, settings)).toMatchObject({ kind: "ignore" });
		expect(routeJob(job, parseSettings({ ALLOW_PUBLIC_REPOS: "true" }))).toMatchObject({ kind: "accept" });
	});

	it("enforces ALLOWED_OWNERS case-insensitively", () => {
		const restricted = parseSettings({ ALLOWED_OWNERS: "Acme, other-org" });
		expect(routeJob(privateJob(["cf-2cpu"], "ACME"), restricted)).toMatchObject({ kind: "accept" });
		expect(routeJob(privateJob(["cf-2cpu"], "intruder"), restricted)).toMatchObject({ kind: "ignore" });
	});
});

describe("runner names", () => {
	it("round-trips size and job ID", () => {
		const size = sizeByLabel("cf-1cpu")!;
		const name = runnerNameFor(size, 41234567890);
		expect(name).toBe("cf-1cpu-41234567890");
		expect(parseRunnerName(name)).toEqual({ size, jobId: 41234567890 });
	});

	it("rejects names that are not ours", () => {
		expect(parseRunnerName("GitHub Actions 12")).toBeUndefined();
		expect(parseRunnerName("cf-3cpu-1")).toBeUndefined();
		expect(parseRunnerName(null)).toBeUndefined();
	});
});

describe("parseSettings", () => {
	it("uses defaults for missing or invalid values", () => {
		const parsed = parseSettings({ IDLE_TIMEOUT_MINUTES: "abc", MAX_JOB_MINUTES: "-5", RUNNER_GROUP_ID: "" });
		expect(parsed).toMatchObject({ idleTimeoutMs: 600_000, maxJobMs: 21_600_000, runnerGroupId: 1, allowPublicRepos: false });
		expect(parsed.allowedOwners.size).toBe(0);
	});

	it("parses configured values", () => {
		const parsed = parseSettings({ IDLE_TIMEOUT_MINUTES: "5", MAX_JOB_MINUTES: "60", RUNNER_GROUP_ID: "7" });
		expect(parsed).toMatchObject({ idleTimeoutMs: 300_000, maxJobMs: 3_600_000, runnerGroupId: 7 });
	});
});
