import type { RunnerTarget, WorkflowJobEvent } from "./github/types";
import { type RunnerSize, type SizeLabel, runnerNameFor, runnerObjectName, sizeByLabel } from "./sizes";

/** Everything a Runner Durable Object needs to start a runner. Persisted in the ledger so the
 * backstop can re-drive a launch without the original webhook. */
export interface LaunchRequest {
	readonly runnerName: string;
	readonly size: SizeLabel;
	readonly jobId: number;
	readonly appId: number;
	readonly installationId: number;
	readonly owner: string;
	readonly ownerType: string;
	readonly repo: string;
	readonly repoFullName: string;
}

export function launchRequestFromEvent(
	event: WorkflowJobEvent,
	size: RunnerSize,
	appId: number,
): LaunchRequest | undefined {
	const installationId = event.installation?.id;
	if (!installationId) return undefined;
	return {
		runnerName: runnerNameFor(size, event.workflow_job.id),
		size: size.label,
		jobId: event.workflow_job.id,
		appId,
		installationId,
		owner: event.repository.owner.login,
		ownerType: event.repository.owner.type,
		repo: event.repository.name,
		repoFullName: event.repository.full_name,
	};
}

/**
 * Organisation-owned repos get organisation runners (needs only the narrow "Self-hosted runners"
 * org permission). Personal repos can only have repository runners.
 */
export function runnerTargetFor(request: LaunchRequest): RunnerTarget {
	return request.ownerType === "Organization"
		? { kind: "org", org: request.owner, installationId: request.installationId }
		: { kind: "repo", owner: request.owner, repo: request.repo, installationId: request.installationId };
}

export function runnerStub(env: Env, sizeLabel: SizeLabel, jobId: number) {
	const size = sizeByLabel(sizeLabel);
	if (!size) throw new Error(`Unknown size ${sizeLabel}`);
	return env[size.binding].getByName(runnerObjectName(jobId));
}

export function ledgerStub(env: Env) {
	return env.JOB_LEDGER.getByName("default");
}

export function registryStub(env: Env) {
	return env.APP_REGISTRY.getByName("default");
}

/** Copies only the launch fields out of a larger object (such as a ledger record). */
export function pickLaunchRequest(source: LaunchRequest): LaunchRequest {
	const { runnerName, size, jobId, appId, installationId, owner, ownerType, repo, repoFullName } = source;
	return { runnerName, size, jobId, appId, installationId, owner, ownerType, repo, repoFullName };
}
