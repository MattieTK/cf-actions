import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubApp, convertManifestCode, isBusyRunnerError, nextPageUrl } from "../src/github/client";
import type { RunnerTarget } from "../src/github/types";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

interface Call {
	url: string;
	method: string;
	auth: string | null;
	body: unknown;
}

/** A fake fetch that records calls and answers from a route table. */
function fakeGitHub(routes: Record<string, (call: Call) => Response>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const call: Call = {
			url,
			method: init?.method ?? "GET",
			auth: headers.get("Authorization"),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const key = `${call.method} ${url.replace("https://api.github.com", "")}`;
		const handler = routes[key];
		if (!handler) return new Response(`no route for ${key}`, { status: 599 });
		return handler(call);
	};
	return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const tokenRoute = () => json({ token: "inst-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);

const orgTarget: RunnerTarget = { kind: "org", org: "acme", installationId: 7 };
const repoTarget: RunnerTarget = { kind: "repo", owner: "alice", repo: "app", installationId: 8 };

describe("GitHubApp", () => {
	it("mints an installation token with an App JWT and caches it", async () => {
		const { calls, fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		expect(await app.installationToken(7)).toBe("inst-token");
		expect(await app.installationToken(7)).toBe("inst-token");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
	});

	it("registers organisation runners at the org endpoint", async () => {
		const { calls, fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
			"POST /orgs/acme/actions/runners/generate-jitconfig": () =>
				json({ runner: { id: 55 }, encoded_jit_config: "abc" }, 201),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		const jit = await app.generateJitConfig(orgTarget, "cf-2cpu-9", ["self-hosted", "cf-2cpu"], 1);
		expect(jit).toEqual({ runnerId: 55, encodedJitConfig: "abc" });
		expect(calls[1]).toMatchObject({
			auth: "Bearer inst-token",
			body: { name: "cf-2cpu-9", labels: ["self-hosted", "cf-2cpu"], runner_group_id: 1 },
		});
	});

	it("registers personal-account runners at the repo endpoint", async () => {
		const { calls, fetchFn } = fakeGitHub({
			"POST /app/installations/8/access_tokens": tokenRoute,
			"POST /repos/alice/app/actions/runners/generate-jitconfig": () =>
				json({ runner: { id: 56 }, encoded_jit_config: "def" }, 201),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		await app.generateJitConfig(repoTarget, "cf-1cpu-3", ["cf-1cpu"], 1);
		expect(calls[1]!.url).toBe("https://api.github.com/repos/alice/app/actions/runners/generate-jitconfig");
	});

	it("treats a missing runner as gone, and a missing runner as deleted", async () => {
		const { fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
			"GET /orgs/acme/actions/runners/55": () => new Response("not found", { status: 404 }),
			"DELETE /orgs/acme/actions/runners/55": () => new Response("not found", { status: 404 }),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		expect(await app.getRunner(orgTarget, 55)).toBeUndefined();
		await expect(app.deleteRunner(orgTarget, 55)).resolves.toBeUndefined();
	});

	it("surfaces a refusal to delete a busy runner as a 422 GitHubApiError", async () => {
		const { fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
			"DELETE /orgs/acme/actions/runners/55": () => new Response("still running a job", { status: 422 }),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		const error = await app.deleteRunner(orgTarget, 55).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitHubApiError);
		expect((error as GitHubApiError).status).toBe(422);
	});

	it("reports runner busy state", async () => {
		const { fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
			"GET /orgs/acme/actions/runners/55": () => json({ id: 55, busy: true, status: "online" }),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		expect(await app.getRunner(orgTarget, 55)).toEqual({ busy: true, status: "online" });
	});

	it("looks up a job's status in its repository, for org and personal installs alike", async () => {
		const { calls, fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
			"GET /repos/acme/app/actions/jobs/777": () => json({ id: 777, status: "queued", name: "test", conclusion: null }),
			"GET /repos/acme/app/actions/jobs/778": () => json({ message: "Not Found" }, 404),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		const repo = { owner: "acme", repo: "app", installationId: 7 };
		expect(await app.getJob(repo, 777)).toEqual({ status: "queued", name: "test" });
		expect(calls[1]!.auth).toBe("Bearer inst-token");
		expect(await app.getJob(repo, 778)).toBeNull();
	});
});

describe("isBusyRunnerError", () => {
	// The body GitHub returned when a busy runner was deleted (cf-actions-trials, 12 Oct 2026).
	const busyBody = JSON.stringify({
		message: "Bad request - Runner cf-1cpu-114614702758 is currently running a job and cannot be deleted.",
		documentation_url: "https://docs.github.com/rest/actions/self-hosted-runners#delete-a-self-hosted-runner-from-a-repository",
		status: "422",
	});

	it("recognises GitHub's refusal to delete a runner that is running a job", () => {
		expect(isBusyRunnerError(new GitHubApiError(422, "/repos/a/b/actions/runners/5", busyBody))).toBe(true);
	});

	it("does not treat other 422s, such as rate limiting, as busy", () => {
		const spammed = JSON.stringify({ message: "Validation Failed", errors: [{ code: "custom", message: "endpoint has been spammed" }] });
		expect(isBusyRunnerError(new GitHubApiError(422, "/repos/a/b/actions/runners/5", spammed))).toBe(false);
		expect(isBusyRunnerError(new GitHubApiError(500, "/repos/a/b/actions/runners/5", busyBody))).toBe(false);
		expect(isBusyRunnerError(new Error("currently running a job"))).toBe(false);
	});
});

describe("webhook deliveries", () => {
	const delivered = (id: number, minutesAgo: number) => ({
		id,
		guid: `g${id}`,
		delivered_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
		redelivery: false,
		status_code: 200,
		event: "workflow_job",
		action: "queued",
	});

	it("follows Link pagination until deliveries are older than the window", async () => {
		const page2 = "https://api.github.com/app/hook/deliveries?per_page=100&cursor=abc";
		const { calls, fetchFn } = fakeGitHub({
			"GET /app/hook/deliveries?per_page=100": () =>
				new Response(JSON.stringify([delivered(3, 1), delivered(2, 10)]), {
					headers: { Link: `<${page2}>; rel="next"` },
				}),
			"GET /app/hook/deliveries?per_page=100&cursor=abc": () =>
				new Response(JSON.stringify([delivered(1, 40)]), {
					headers: { Link: `<${page2}&cursor=def>; rel="next"` },
				}),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		const deliveries = await app.listDeliveriesSince(Date.now() - 30 * 60_000);
		expect(deliveries.map((d) => d.id)).toEqual([3, 2, 1]);
		expect(calls).toHaveLength(2);
	});

	it("parses only same-API next links", () => {
		expect(nextPageUrl('<https://api.github.com/x?cursor=1>; rel="next", <https://api.github.com/x>; rel="first"')).toBe(
			"https://api.github.com/x?cursor=1",
		);
		expect(nextPageUrl('<https://evil.example/x>; rel="next"')).toBeUndefined();
		expect(nextPageUrl(null)).toBeUndefined();
	});
});

describe("findRunnerByName", () => {
	it("returns the exact-name match", async () => {
		const { fetchFn } = fakeGitHub({
			"POST /app/installations/7/access_tokens": tokenRoute,
			"GET /orgs/acme/actions/runners?name=cf-2cpu-9": () =>
				json({ total_count: 2, runners: [{ id: 1, name: "cf-2cpu-90" }, { id: 2, name: "cf-2cpu-9" }] }),
		});
		const app = new GitHubApp({ appId: 1, privateKey }, fetchFn, Date.now, new Map());
		expect(await app.findRunnerByName(orgTarget, "cf-2cpu-9")).toBe(2);
	});
});

describe("convertManifestCode", () => {
	it("maps the conversion response to stored credentials", async () => {
		const { calls, fetchFn } = fakeGitHub({
			"POST /app-manifests/the-code/conversions": () =>
				json(
					{
						id: 99,
						slug: "cf-actions-x",
						name: "cf-actions-x",
						owner: { login: "acme", type: "Organization" },
						html_url: "https://github.com/apps/cf-actions-x",
						pem: privateKey,
						webhook_secret: "whsec",
					},
					201,
				),
		});
		const creds = await convertManifestCode("the-code", fetchFn);
		expect(creds).toMatchObject({ appId: 99, ownerLogin: "acme", ownerType: "Organization", webhookSecret: "whsec" });
		expect(calls[0]!.auth).toBeNull();
	});
});
