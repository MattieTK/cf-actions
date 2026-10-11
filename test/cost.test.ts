import { describe, expect, it } from "vitest";
import { cloudflareCostUsd, githubCostUsd } from "../src/cost";
import type { RunnerRecord } from "../src/durable/job-ledger";
import { sizeByLabel } from "../src/sizes";
import { formatDuration, formatUsd, runnerCost, summarise } from "../src/status";
import { decideWatchdog } from "../src/watchdog";

const twoCpu = sizeByLabel("cf-2cpu")!;
const fourCpu = sizeByLabel("cf-4cpu")!;

describe("cloudflareCostUsd", () => {
	it("matches the published per-second rates for a busy standard-3", () => {
		// 2 vCPU × $0.00002 + 8 GiB × $0.0000025 + 16 GB × $0.00000007 per second
		expect(cloudflareCostUsd(twoCpu, 60)).toBeCloseTo(0.0036672, 7);
	});

	it("bills memory and disk but less CPU when the CPU is mostly idle", () => {
		const busy = cloudflareCostUsd(fourCpu, 60, 1);
		const idle = cloudflareCostUsd(fourCpu, 60, 0.3);
		expect(idle).toBeLessThan(busy);
		expect(idle).toBeCloseTo(60 * (4 * 0.3 * 0.00002 + 12 * 0.0000025 + 20 * 0.00000007), 9);
	});

	it("treats non-positive durations as free", () => {
		expect(cloudflareCostUsd(twoCpu, 0)).toBe(0);
		expect(cloudflareCostUsd(twoCpu, -5)).toBe(0);
	});
});

describe("githubCostUsd", () => {
	it("rounds every job up to a whole minute", () => {
		expect(githubCostUsd(twoCpu, 15)).toBeCloseTo(0.006);
		expect(githubCostUsd(twoCpu, 61)).toBeCloseTo(0.012);
		expect(githubCostUsd(fourCpu, 600)).toBeCloseTo(0.12);
	});
});

function record(overrides: Partial<RunnerRecord>): RunnerRecord {
	return {
		runnerName: "cf-2cpu-1",
		size: "cf-2cpu",
		jobId: 1,
		jobName: "test",
		appId: 1,
		installationId: 1,
		owner: "acme",
		ownerType: "Organization",
		repo: "app",
		repoFullName: "acme/app",
		status: "stopped",
		createdAt: 0,
		launchAttempts: 1,
		runnerId: 9,
		startedAt: 0,
		stoppedAt: 120_000,
		exitCode: 0,
		stopReason: "exit",
		assignedJobId: 1,
		assignedJobName: "test",
		jobStartedAt: 5_000,
		jobCompletedAt: 95_000,
		conclusion: "success",
		error: null,
		...overrides,
	};
}

describe("runnerCost and summarise", () => {
	it("bills Cloudflare for container time and GitHub for job time", () => {
		const cost = runnerCost(record({}), 0);
		expect(cost.containerSeconds).toBe(120);
		expect(cost.jobSeconds).toBe(90);
		expect(cost.githubUsd).toBeCloseTo(0.012); // 90s rounds up to 2 minutes
		expect(cost.cloudflareMaxUsd).toBeCloseTo(cloudflareCostUsd(twoCpu, 120));
	});

	it("counts a still-running container up to now", () => {
		const cost = runnerCost(record({ status: "running", stoppedAt: null }), 30_000);
		expect(cost.containerSeconds).toBe(30);
	});

	it("costs nothing for runners that never started", () => {
		const cost = runnerCost(record({ status: "failed", startedAt: null, stoppedAt: null }), 0);
		expect(cost).toEqual({ containerSeconds: 0, jobSeconds: 0, cloudflareMaxUsd: 0, githubUsd: 0 });
	});

	it("totals across runners", () => {
		const summary = summarise([record({}), record({ jobCompletedAt: null, jobStartedAt: null })], 0);
		expect(summary.runners).toBe(2);
		expect(summary.jobsCompleted).toBe(1);
		expect(summary.containerMinutes).toBeCloseTo(4);
		expect(summary.githubUsd).toBeCloseTo(0.012);
	});
});

describe("decideWatchdog", () => {
	const base = { startedAt: 0, idleTimeoutMs: 600_000, maxJobMs: 3_600_000 };

	it("leaves young or busy runners alone", () => {
		expect(decideWatchdog({ ...base, now: 60_000, assigned: false })).toBe("continue");
		expect(decideWatchdog({ ...base, now: 1_200_000, assigned: true })).toBe("continue");
	});

	it("checks idle runners after the idle timeout", () => {
		expect(decideWatchdog({ ...base, now: 600_000, assigned: false })).toBe("check-idle");
	});

	it("stops anything past the maximum job time", () => {
		expect(decideWatchdog({ ...base, now: 3_600_000, assigned: true })).toBe("stop-overdue");
	});
});

describe("formatting", () => {
	it("never renders 60 seconds", () => {
		expect(formatDuration(119.6)).toBe("2m 0s");
		expect(formatDuration(59.4)).toBe("59s");
		expect(formatDuration(0.2)).toBe("–");
	});

	it("puts the sign before the currency symbol", () => {
		expect(formatUsd(-0.0012)).toBe("-$0.0012");
		expect(formatUsd(12.345)).toBe("$12.35");
	});
});
