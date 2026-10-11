import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppRegistry } from "../../src/durable/app-registry";
import type { LaunchRequest } from "../../src/launch";

// A fresh Durable Object per test keeps tests independent of storage isolation settings.
const ledger = () => env.JOB_LEDGER.getByName(crypto.randomUUID());
const registry = () => env.APP_REGISTRY.getByName(crypto.randomUUID());

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-11T12:00:00Z");

function request(jobId: number): LaunchRequest {
	return {
		runnerName: `cf-2cpu-${jobId}`,
		size: "cf-2cpu",
		jobId,
		appId: 1,
		installationId: 2,
		owner: "acme",
		ownerType: "Organization",
		repo: "app",
		repoFullName: "acme/app",
	};
}

describe("JobLedger", () => {
	it("records each runner once", async () => {
		const stub = ledger();
		expect(await stub.recordQueued(request(1), "test", T0)).toBe(true);
		expect(await stub.recordQueued(request(1), "test", T0 + 5)).toBe(false);
		const row = await stub.get("cf-2cpu-1");
		expect(row).toMatchObject({ status: "pending", jobName: "test", createdAt: T0, launchAttempts: 0 });
	});

	it("counts launch attempts and reports the row's age", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		expect(await stub.markLaunchAttempt("cf-2cpu-1", T0 + 1)).toEqual({ attempts: 1, createdAt: T0 });
		expect(await stub.markLaunchAttempt("cf-2cpu-1", T0 + 2)).toEqual({ attempts: 2, createdAt: T0 });
		expect(await stub.markLaunchAttempt("cf-2cpu-missing", T0)).toBeNull();
	});

	it("backs off re-drives: 1, 2, 4, 8, then at most 15 minutes after the last attempt", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		const due = async (now: number) => (await stub.listStuckPending(now, now)).map((r) => r.runnerName);

		expect(await due(T0 + 3 * MINUTE)).toEqual(["cf-2cpu-1"]); // never attempted

		let last = T0 + 3 * MINUTE;
		for (const [attempt, wait] of [
			[1, 1],
			[2, 2],
			[3, 4],
			[4, 8],
			[5, 15],
			[9, 15],
		] as const) {
			while ((await stub.markLaunchAttempt("cf-2cpu-1", last))!.attempts < attempt) {}
			expect(await due(last + wait * MINUTE - 1)).toEqual([]);
			expect(await due(last + wait * MINUTE)).toEqual(["cf-2cpu-1"]);
			last += wait * MINUTE;
		}
	});

	it("does not re-drive rows that are no longer pending", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		await stub.markLaunchFailed("cf-2cpu-1", "boom", true);
		expect(await stub.listStuckPending(T0 + MINUTE, T0 + MINUTE)).toEqual([]);
		expect((await stub.get("cf-2cpu-1"))!.status).toBe("failed");
	});

	it("keeps a launch pending on a retryable failure", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		await stub.markLaunchFailed("cf-2cpu-1", "no capacity", false);
		expect(await stub.get("cf-2cpu-1")).toMatchObject({ status: "pending", error: "no capacity" });
	});

	it("marks running, and recovers failed rows whose container did start", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		await stub.markLaunchFailed("cf-2cpu-1", "timeout", true);
		expect(await stub.markRunning("cf-2cpu-1", 77, T0 + 10)).toEqual({ cancelled: false });
		expect(await stub.get("cf-2cpu-1")).toMatchObject({ status: "running", runnerId: 77, startedAt: T0 + 10, error: null });
	});

	it("keeps a cancelled row cancelled when its container starts late, and says so", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		await stub.recordCompleted({ runnerName: null, jobId: 1, jobName: "test", conclusion: "cancelled", startedAt: null, completedAt: T0 + 5 });
		expect(await stub.markRunning("cf-2cpu-1", 77, T0 + 10)).toEqual({ cancelled: true });
		expect(await stub.get("cf-2cpu-1")).toMatchObject({ status: "cancelled", startedAt: T0 + 10 });
	});

	it("records a stop once, idempotently", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "test", T0);
		await stub.markRunning("cf-2cpu-1", 77, T0 + 10);
		await stub.noteStopReason("cf-2cpu-1", "idle-timeout");
		await stub.markStopped("cf-2cpu-1", { stoppedAt: T0 + 100, exitCode: 0, reason: "exit" });
		await stub.markStopped("cf-2cpu-1", { stoppedAt: T0 + 999, exitCode: 1, reason: "lost" });
		expect(await stub.get("cf-2cpu-1")).toMatchObject({
			status: "stopped",
			stoppedAt: T0 + 100,
			exitCode: 0,
			stopReason: "idle-timeout",
		});
	});

	it("records assignment and completion against the runner that ran the job", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "first", T0);
		await stub.recordQueued(request(2), "second", T0);
		// Job 2 ran on the runner launched for job 1.
		await stub.recordAssigned("cf-2cpu-1", 2, "second", T0 + 20);
		const result = await stub.recordCompleted({
			runnerName: "cf-2cpu-1",
			jobId: 2,
			jobName: "second",
			conclusion: "success",
			startedAt: T0 + 20,
			completedAt: T0 + 80,
		});
		expect(result).toEqual({ launched: true });
		expect(await stub.get("cf-2cpu-1")).toMatchObject({
			assignedJobId: 2,
			assignedJobName: "second",
			jobStartedAt: T0 + 20,
			jobCompletedAt: T0 + 80,
			conclusion: "success",
		});
		// Job 2 completed, so the runner launched for it must not be re-driven any more.
		expect((await stub.get("cf-2cpu-2"))!.status).toBe("cancelled");
	});

	it("tells the caller when a completed job was never launched", async () => {
		const stub = ledger();
		const result = await stub.recordCompleted({ runnerName: null, jobId: 5, jobName: "x", conclusion: "cancelled", startedAt: null, completedAt: T0 });
		expect(result).toEqual({ launched: false });
	});

	it("lists overdue running rows and prunes old ones", async () => {
		const stub = ledger();
		await stub.recordQueued(request(1), "old", T0);
		await stub.markRunning("cf-2cpu-1", 1, T0);
		await stub.recordQueued(request(2), "new", T0 + 60 * MINUTE);
		await stub.markRunning("cf-2cpu-2", 2, T0 + 60 * MINUTE);
		expect((await stub.listOverdueRunning(T0 + MINUTE)).map((r) => r.runnerName)).toEqual(["cf-2cpu-1"]);
		expect(await stub.prune(T0 + MINUTE)).toBe(1);
		expect((await stub.listRecent(10)).map((r) => r.runnerName)).toEqual(["cf-2cpu-2"]);
	});
});

describe("AppRegistry", () => {
	const creds = {
		appId: 42,
		slug: "cf-actions-x",
		name: "cf-actions-x",
		ownerLogin: "acme",
		ownerType: "Organization",
		htmlUrl: "https://github.com/apps/cf-actions-x",
		privateKey: "-----BEGIN RSA PRIVATE KEY-----\nsecret-key-material\n-----END RSA PRIVATE KEY-----",
		webhookSecret: "whsec-value",
	};

	it("round-trips credentials and lists Apps without secrets", async () => {
		const stub = registry();
		await stub.saveApp(creds);
		expect(await stub.getApp(42)).toEqual(creds);
		expect(await stub.getApp(43)).toBeNull();
		const [summary] = await stub.listApps();
		expect(summary).toMatchObject({ appId: 42, ownerLogin: "acme" });
		expect(JSON.stringify(summary)).not.toContain("whsec-value");
	});

	it("stores the private key and webhook secret encrypted", async () => {
		const stub = registry();
		await stub.saveApp(creds);
		const stored = await runInDurableObject(stub, (instance: AppRegistry, state) =>
			JSON.stringify(state.storage.sql.exec("SELECT * FROM apps").toArray()),
		);
		expect(stored).not.toContain("secret-key-material");
		expect(stored).not.toContain("whsec-value");
		expect(stored).toContain('"secrets":"v1.');
	});

	it("accepts each setup state once", async () => {
		const stub = registry();
		const state = await stub.createSetupState({ kind: "org", org: "acme" });
		expect(await stub.consumeSetupState(state)).toEqual({ kind: "org", org: "acme" });
		expect(await stub.consumeSetupState(state)).toBeNull();
		expect(await stub.consumeSetupState("forged")).toBeNull();
	});

	it("rejects expired setup states", async () => {
		const stub = registry();
		const state = await stub.createSetupState({ kind: "user" });
		await runInDurableObject(stub, (_instance: AppRegistry, ctx) => {
			ctx.storage.sql.exec("UPDATE setup_states SET expires_at = 0");
		});
		expect(await stub.consumeSetupState(state)).toBeNull();
	});
});
