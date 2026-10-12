import { createAppJwt, importRsaPrivateKey } from "../crypto";
import type { AppCredentials, RunnerTarget, WebhookDelivery } from "./types";

const API = "https://api.github.com";
// A hung call would hold a Runner's launch open, and every later launch for that job joins it.
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`GitHub API ${status} for ${path}: ${body.slice(0, 300)}`);
		this.name = "GitHubApiError";
	}
}

/**
 * GitHub answers a delete of a runner that is mid-job with 422 and "Runner <name> is currently
 * running a job and cannot be deleted." It also uses 422 for validation errors and rate limiting,
 * so only that message means busy.
 */
export function isBusyRunnerError(error: unknown): boolean {
	return error instanceof GitHubApiError && error.status === 422 && /currently running a job/i.test(error.body);
}

interface CachedToken {
	readonly token: string;
	readonly expiresAt: number;
}

/**
 * Installation tokens last an hour; caching them per isolate avoids minting one per webhook.
 * Module scope is shared by every request handled by the same isolate.
 */
const tokenCache = new Map<string, CachedToken>();

function targetPath(target: RunnerTarget): string {
	return target.kind === "org"
		? `/orgs/${encodeURIComponent(target.org)}/actions/runners`
		: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/actions/runners`;
}

export interface JitConfig {
	readonly runnerId: number;
	readonly encodedJitConfig: string;
}

export interface RunnerStatus {
	readonly busy: boolean;
	readonly status: string;
}

export interface JobStatus {
	/** queued, waiting, in_progress, completed, ... */
	readonly status: string;
	readonly name: string;
}

export class GitHubApp {
	private keyPromise: Promise<CryptoKey> | undefined;

	constructor(
		private readonly creds: Pick<AppCredentials, "appId" | "privateKey">,
		private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
		private readonly now: () => number = Date.now,
		private readonly cache: Map<string, CachedToken> = tokenCache,
	) {}

	get appId(): number {
		return this.creds.appId;
	}

	private async appJwt(): Promise<string> {
		this.keyPromise ??= importRsaPrivateKey(this.creds.privateKey);
		return createAppJwt(this.creds.appId, await this.keyPromise, this.now());
	}

	private async send(path: string, auth: string, init: RequestInit = {}): Promise<Response> {
		return this.fetchFn(path.startsWith("https://") ? path : `${API}${path}`, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			...init,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: auth,
				"User-Agent": "cf-actions",
				"X-GitHub-Api-Version": "2022-11-28",
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
		});
	}

	private async json<T>(path: string, auth: string, init?: RequestInit): Promise<T> {
		const response = await this.send(path, auth, init);
		if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
		return (await response.json()) as T;
	}

	async installationToken(installationId: number): Promise<string> {
		const key = `${this.creds.appId}:${installationId}`;
		const cached = this.cache.get(key);
		// Refresh five minutes early so a token never expires mid-request.
		if (cached && cached.expiresAt - 5 * 60_000 > this.now()) return cached.token;

		const path = `/app/installations/${installationId}/access_tokens`;
		const result = await this.json<{ token: string; expires_at: string }>(path, `Bearer ${await this.appJwt()}`, {
			method: "POST",
		});
		this.cache.set(key, { token: result.token, expiresAt: Date.parse(result.expires_at) });
		return result.token;
	}

	private async asInstallation(target: RunnerTarget): Promise<string> {
		return `Bearer ${await this.installationToken(target.installationId)}`;
	}

	async generateJitConfig(
		target: RunnerTarget,
		name: string,
		labels: readonly string[],
		runnerGroupId: number,
	): Promise<JitConfig> {
		const result = await this.json<{ runner: { id: number }; encoded_jit_config: string }>(
			`${targetPath(target)}/generate-jitconfig`,
			await this.asInstallation(target),
			{ method: "POST", body: JSON.stringify({ name, labels, runner_group_id: runnerGroupId }) },
		);
		return { runnerId: result.runner.id, encodedJitConfig: result.encoded_jit_config };
	}

	/** Returns undefined when the runner no longer exists (ephemeral runners remove themselves). */
	async getRunner(target: RunnerTarget, runnerId: number): Promise<RunnerStatus | undefined> {
		const path = `${targetPath(target)}/${runnerId}`;
		const response = await this.send(path, await this.asInstallation(target));
		if (response.status === 404) return undefined;
		if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
		const runner = (await response.json()) as { busy: boolean; status: string };
		return { busy: runner.busy, status: runner.status };
	}

	/** A job's current status and name, or null when the job no longer exists. Needs Actions: read. */
	async getJob(
		repo: { readonly owner: string; readonly repo: string; readonly installationId: number },
		jobId: number,
	): Promise<JobStatus | null> {
		const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/jobs/${jobId}`;
		const response = await this.send(path, `Bearer ${await this.installationToken(repo.installationId)}`);
		if (response.status === 404) return null;
		if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
		const job = (await response.json()) as { status: string; name: string };
		return { status: job.status, name: job.name };
	}

	/** Finds a registration by name, for cleaning up one whose ID was never recorded. */
	async findRunnerByName(target: RunnerTarget, name: string): Promise<number | undefined> {
		const path = `${targetPath(target)}?name=${encodeURIComponent(name)}`;
		const result = await this.json<{ runners: { id: number; name: string }[] }>(path, await this.asInstallation(target));
		return result.runners.find((runner) => runner.name === name)?.id;
	}

	/** Removes a registration whose container is gone. A missing runner counts as success. */
	async deleteRunner(target: RunnerTarget, runnerId: number): Promise<void> {
		const path = `${targetPath(target)}/${runnerId}`;
		const response = await this.send(path, await this.asInstallation(target), { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new GitHubApiError(response.status, path, await response.text());
		}
	}

	/**
	 * Deliveries of the App's webhook, newest first, back to `since` (or `maxPages` pages). The App
	 * receives `workflow_job` for every job in installed repositories, GitHub-hosted ones included,
	 * so one page can cover less than a minute in a busy organisation.
	 */
	async listDeliveriesSince(since: number, maxPages = 5): Promise<WebhookDelivery[]> {
		const deliveries: WebhookDelivery[] = [];
		let path: string | undefined = "/app/hook/deliveries?per_page=100";
		for (let page = 0; path && page < maxPages; page++) {
			const response = await this.send(path, `Bearer ${await this.appJwt()}`);
			if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
			const batch = (await response.json()) as WebhookDelivery[];
			deliveries.push(...batch);
			const oldest = batch.at(-1);
			if (!oldest || Date.parse(oldest.delivered_at) < since) break;
			path = nextPageUrl(response.headers.get("Link"));
		}
		return deliveries;
	}

	async redeliver(deliveryId: number): Promise<void> {
		const path = `/app/hook/deliveries/${deliveryId}/attempts`;
		const response = await this.send(path, `Bearer ${await this.appJwt()}`, { method: "POST" });
		if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
	}
}

/** Extracts the `rel="next"` URL from a GitHub `Link` header. */
export function nextPageUrl(link: string | null): string | undefined {
	if (!link) return undefined;
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
		if (match?.[1]?.startsWith(`${API}/`)) return match[1];
	}
	return undefined;
}

/**
 * Completes the App manifest flow: exchanges the temporary code GitHub redirected back with for
 * the new App's ID, private key and webhook secret. The code is valid for one hour, once.
 */
export async function convertManifestCode(
	code: string,
	fetchFn: FetchFn = (input, init) => fetch(input, init),
): Promise<AppCredentials> {
	const path = `/app-manifests/${encodeURIComponent(code)}/conversions`;
	const response = await fetchFn(`${API}${path}`, {
		method: "POST",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "cf-actions",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
	const app = (await response.json()) as {
		id: number;
		slug: string;
		name: string;
		owner: { login: string; type: string };
		html_url: string;
		pem: string;
		webhook_secret: string;
	};
	return {
		appId: app.id,
		slug: app.slug,
		name: app.name,
		ownerLogin: app.owner.login,
		ownerType: app.owner.type,
		htmlUrl: app.html_url,
		privateKey: app.pem,
		webhookSecret: app.webhook_secret,
	};
}
