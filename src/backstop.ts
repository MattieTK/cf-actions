import { GitHubApp } from "./github/client";
import type { WebhookDelivery } from "./github/types";
import { ledgerStub, pickLaunchRequest, registryStub, runnerStub } from "./launch";
import { parseSettings } from "./settings";

const MINUTE_MS = 60_000;
export const REDELIVERY_WINDOW_MS = 30 * MINUTE_MS;
export const MAX_DELIVERY_ATTEMPTS = 3;
const PENDING_GRACE_MS = 2 * MINUTE_MS;
const OVERDUE_GRACE_MS = 20 * MINUTE_MS;
const LEDGER_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;

const succeeded = (delivery: WebhookDelivery) => delivery.status_code >= 200 && delivery.status_code < 300;

/**
 * Picks `workflow_job` deliveries to redeliver: those in the window whose every attempt failed,
 * and that have not yet been attempted `maxAttempts` times. Returns the newest attempt's ID for
 * each, since that is the one GitHub redelivers from.
 */
export function selectRedeliveries(
	deliveries: readonly WebhookDelivery[],
	now: number,
	windowMs = REDELIVERY_WINDOW_MS,
	maxAttempts = MAX_DELIVERY_ATTEMPTS,
): number[] {
	const byGuid = new Map<string, WebhookDelivery[]>();
	for (const delivery of deliveries) {
		if (delivery.event !== "workflow_job") continue;
		if (now - Date.parse(delivery.delivered_at) > windowMs) continue;
		byGuid.set(delivery.guid, [...(byGuid.get(delivery.guid) ?? []), delivery]);
	}
	const selected: number[] = [];
	for (const attempts of byGuid.values()) {
		if (attempts.some(succeeded) || attempts.length >= maxAttempts) continue;
		const newest = attempts.reduce((a, b) => (Date.parse(b.delivered_at) > Date.parse(a.delivered_at) ? b : a));
		selected.push(newest.id);
	}
	return selected;
}

async function redeliverFailedWebhooks(env: Env, now: number): Promise<void> {
	const registry = registryStub(env);
	for (const summary of await registry.listApps()) {
		try {
			const creds = await registry.getApp(summary.appId);
			if (!creds) continue;
			const github = new GitHubApp(creds);
			const ids = selectRedeliveries(await github.listDeliveriesSince(now - REDELIVERY_WINDOW_MS), now);
			for (const id of ids) await github.redeliver(id);
			if (ids.length > 0) console.log(`redelivered ${ids.length} webhook(s) for App ${summary.appId}`);
		} catch (error) {
			console.error(`webhook redelivery for App ${summary.appId} failed`, error);
		}
	}
}

async function redriveStuckLaunches(env: Env, now: number): Promise<void> {
	for (const record of await ledgerStub(env).listStuckPending(now - PENDING_GRACE_MS, now)) {
		try {
			const outcome = await runnerStub(env, record.size, record.jobId).launch(pickLaunchRequest(record));
			console.log(`re-drove ${record.runnerName}: ${outcome}`);
		} catch (error) {
			console.error(`re-drive of ${record.runnerName} failed`, error);
		}
	}
}

async function reconcileOverdueRunners(env: Env, now: number): Promise<void> {
	const { maxJobMs } = parseSettings(env);
	for (const record of await ledgerStub(env).listOverdueRunning(now - maxJobMs - OVERDUE_GRACE_MS)) {
		try {
			await runnerStub(env, record.size, record.jobId).reconcile();
		} catch (error) {
			console.error(`reconcile of ${record.runnerName} failed`, error);
		}
	}
}

/** Runs every minute from the cron trigger. Each step is independent and failure-tolerant. */
export async function runBackstop(env: Env, now = Date.now()): Promise<void> {
	await Promise.allSettled([
		redeliverFailedWebhooks(env, now),
		redriveStuckLaunches(env, now),
		reconcileOverdueRunners(env, now),
		ledgerStub(env).prune(now - LEDGER_RETENTION_MS),
	]);
}
