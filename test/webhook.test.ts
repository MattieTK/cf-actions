import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebhook } from "../src/webhook";

const SECRET = "webhook-secret";
const APP_ID = 4242;

/** Fake env: each Durable Object namespace hands out one shared stub per name. */
function fakeEnv(overrides: Record<string, string> = {}) {
	const ledger = {
		recordQueued: vi.fn(async () => true),
		recordAssigned: vi.fn(async () => undefined),
		recordCompleted: vi.fn(async () => ({ launched: true })),
	};
	const registry = {
		getApp: vi.fn(async (appId: number) => (appId === APP_ID ? { appId, webhookSecret: SECRET } : null)),
	};
	const runners = new Map<string, { launch: ReturnType<typeof vi.fn>; markAssigned: ReturnType<typeof vi.fn>; cancelIfIdle: ReturnType<typeof vi.fn> }>();
	const runnerNamespace = (binding: string) => ({
		getByName: (name: string) => {
			const key = `${binding}/${name}`;
			if (!runners.has(key)) {
				runners.set(key, {
					launch: vi.fn(async () => "started"),
					markAssigned: vi.fn(async () => undefined),
					cancelIfIdle: vi.fn(async () => true),
				});
			}
			return runners.get(key)!;
		},
	});
	const env = {
		ALLOWED_OWNERS: "",
		ALLOW_PUBLIC_REPOS: "false",
		IDLE_TIMEOUT_MINUTES: "10",
		MAX_JOB_MINUTES: "360",
		RUNNER_GROUP_ID: "1",
		...overrides,
		JOB_LEDGER: { getByName: () => ledger },
		APP_REGISTRY: { getByName: () => registry },
		RUNNER_1CPU: runnerNamespace("RUNNER_1CPU"),
		RUNNER_2CPU: runnerNamespace("RUNNER_2CPU"),
		RUNNER_4CPU: runnerNamespace("RUNNER_4CPU"),
	};
	return { env: env as unknown as Env, ledger, registry, runners };
}

function fakeCtx() {
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined };
	return { ctx: ctx as unknown as ExecutionContext, settle: () => Promise.all(pending) };
}

function jobEvent(action: string, job: Record<string, unknown> = {}, repo: Record<string, unknown> = {}) {
	return {
		action,
		workflow_job: {
			id: 777,
			run_id: 1,
			name: "test",
			labels: ["cf-2cpu"],
			status: action,
			conclusion: null,
			runner_name: null,
			started_at: "2026-10-11T12:00:00Z",
			completed_at: null,
			...job,
		},
		repository: { name: "app", full_name: "acme/app", private: true, owner: { login: "acme", type: "Organization" }, ...repo },
		installation: { id: 99 },
	};
}

function signedRequest(payload: unknown, { event = "workflow_job", secret = SECRET, appId = String(APP_ID) } = {}) {
	const body = JSON.stringify(payload);
	const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	return new Request("https://worker.example/webhook", {
		method: "POST",
		body,
		headers: {
			"X-GitHub-Event": event,
			"X-Hub-Signature-256": signature,
			"X-GitHub-Hook-Installation-Target-ID": appId,
		},
	});
}

describe("handleWebhook", () => {
	let fixture: ReturnType<typeof fakeEnv>;
	let context: ReturnType<typeof fakeCtx>;

	beforeEach(() => {
		fixture = fakeEnv();
		context = fakeCtx();
	});

	it("rejects bad signatures and unknown Apps", async () => {
		const bad = await handleWebhook(signedRequest(jobEvent("queued"), { secret: "wrong" }), fixture.env, context.ctx);
		expect(bad.status).toBe(401);
		const unknown = await handleWebhook(signedRequest(jobEvent("queued"), { appId: "1" }), fixture.env, context.ctx);
		expect(unknown.status).toBe(404);
		expect(fixture.ledger.recordQueued).not.toHaveBeenCalled();
	});

	it("answers pings", async () => {
		const response = await handleWebhook(signedRequest({ zen: "hi" }, { event: "ping" }), fixture.env, context.ctx);
		expect(await response.text()).toBe("pong");
	});

	it("records and launches a queued job on the matching size", async () => {
		const response = await handleWebhook(signedRequest(jobEvent("queued")), fixture.env, context.ctx);
		await context.settle();
		expect(response.status).toBe(202);
		const expected = {
			runnerName: "cf-2cpu-777",
			size: "cf-2cpu",
			jobId: 777,
			appId: APP_ID,
			installationId: 99,
			owner: "acme",
			ownerType: "Organization",
			repo: "app",
			repoFullName: "acme/app",
		};
		expect(fixture.ledger.recordQueued).toHaveBeenCalledWith(expected, "test", expect.any(Number));
		expect(fixture.runners.get("RUNNER_2CPU/job-777")!.launch).toHaveBeenCalledWith(expected);
	});

	it("ignores jobs for GitHub-hosted runners and public repos", async () => {
		await handleWebhook(signedRequest(jobEvent("queued", { labels: ["ubuntu-latest"] })), fixture.env, context.ctx);
		await handleWebhook(signedRequest(jobEvent("queued", {}, { private: false })), fixture.env, context.ctx);
		await context.settle();
		expect(fixture.ledger.recordQueued).not.toHaveBeenCalled();
		expect(fixture.runners.size).toBe(0);
	});

	it("marks the runner that picked up a job as assigned, even if it was launched for another job", async () => {
		const event = jobEvent("in_progress", { id: 778, runner_name: "cf-2cpu-777" });
		await handleWebhook(signedRequest(event), fixture.env, context.ctx);
		expect(fixture.ledger.recordAssigned).toHaveBeenCalledWith("cf-2cpu-777", 778, "test", Date.parse("2026-10-11T12:00:00Z"));
		expect(fixture.runners.get("RUNNER_2CPU/job-777")!.markAssigned).toHaveBeenCalled();
	});

	it("traces a relaunched runner (suffixed attempt) back to its job's Durable Object and ledger row", async () => {
		const event = jobEvent("in_progress", { runner_name: "cf-2cpu-777-2" });
		await handleWebhook(signedRequest(event), fixture.env, context.ctx);
		expect(fixture.ledger.recordAssigned).toHaveBeenCalledWith("cf-2cpu-777-2", 777, "test", Date.parse("2026-10-11T12:00:00Z"));
		expect(fixture.runners.get("RUNNER_2CPU/job-777")!.markAssigned).toHaveBeenCalled();
	});

	it("passes a repeat queued webhook to the job's Runner, which decides whether to relaunch", async () => {
		// GitHub sends `queued` again once an environment approval is granted.
		await handleWebhook(signedRequest(jobEvent("queued")), fixture.env, context.ctx);
		await handleWebhook(signedRequest(jobEvent("queued")), fixture.env, context.ctx);
		await context.settle();
		expect(fixture.runners.get("RUNNER_2CPU/job-777")!.launch).toHaveBeenCalledTimes(2);
	});

	it("frees the launched runner when its job is cancelled before starting", async () => {
		const event = jobEvent("completed", { conclusion: "cancelled", completed_at: "2026-10-11T12:01:00Z" });
		await handleWebhook(signedRequest(event), fixture.env, context.ctx);
		await context.settle();
		expect(fixture.ledger.recordCompleted).toHaveBeenCalledWith(expect.objectContaining({ runnerName: null, jobId: 777 }));
		expect(fixture.runners.get("RUNNER_2CPU/job-777")!.cancelIfIdle).toHaveBeenCalled();
	});

	it("does not touch runners for jobs we never launched", async () => {
		fixture.ledger.recordCompleted.mockResolvedValueOnce({ launched: false });
		const event = jobEvent("completed", { conclusion: "cancelled", completed_at: "2026-10-11T12:01:00Z" });
		await handleWebhook(signedRequest(event), fixture.env, context.ctx);
		await context.settle();
		expect(fixture.runners.size).toBe(0);
	});

	it("records completion without cancelling when one of our runners ran the job", async () => {
		const event = jobEvent("completed", { runner_name: "cf-2cpu-777", conclusion: "success", completed_at: "2026-10-11T12:05:00Z" });
		await handleWebhook(signedRequest(event), fixture.env, context.ctx);
		await context.settle();
		expect(fixture.ledger.recordCompleted).toHaveBeenCalledWith(
			expect.objectContaining({ runnerName: "cf-2cpu-777", conclusion: "success" }),
		);
		expect(fixture.runners.get("RUNNER_2CPU/job-777")?.cancelIfIdle ?? vi.fn()).not.toHaveBeenCalled();
	});
});
