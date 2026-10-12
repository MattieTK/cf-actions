import type { LaunchRequest } from "./launch";
import { parseRunnerName, runnerNameFor, sizeByLabel } from "./sizes";

export interface RelaunchInput {
	readonly phase: "launching" | "running" | "stopped";
	/** Whether the runner is known to have run a job. */
	readonly assigned: boolean;
}

/**
 * Whether a `queued` webhook for a job should start a new runner for it. GitHub sends `queued`
 * before an environment approval and again after it, so the runner launched for the first one
 * may have been stopped as idle by the time the job can run.
 *
 * `jobStatus` is the job's current status from GitHub: `null` when the job no longer exists and
 * `undefined` when it could not be looked up. A failed lookup relaunches, because an unneeded
 * runner costs at most one idle timeout while a stranded job waits up to 24 hours.
 */
export function shouldRelaunch(state: RelaunchInput, jobStatus: string | null | undefined): boolean {
	if (state.phase !== "stopped" || state.assigned) return false;
	return jobStatus === undefined || jobStatus === "queued";
}

/**
 * Whether to relaunch after the idle watchdog removed a runner. If the job's approval came just
 * before the idle check, its second `queued` webhook already found this runner alive, so nothing
 * else will start one. Only a confirmed `queued` counts: relaunching on a failed lookup could start
 * a fresh idle runner every idle timeout while a job awaits approval.
 */
export function shouldRelaunchAfterIdleStop(jobStatus: string | null | undefined): boolean {
	return jobStatus === "queued";
}

function attemptOf(request: LaunchRequest): number {
	return parseRunnerName(request.runnerName)?.attempt ?? 1;
}

/**
 * The launch request for a job's next runner. When `incoming` already names a later attempt (the
 * backstop re-driving a relaunch recorded earlier), that attempt is reused so each relaunch gets
 * exactly one ledger row.
 */
export function relaunchRequest(current: LaunchRequest, incoming: LaunchRequest): LaunchRequest {
	if (attemptOf(incoming) > attemptOf(current)) return incoming;
	const size = sizeByLabel(current.size);
	if (!size) throw new Error(`Unknown size ${current.size}`);
	return { ...current, runnerName: runnerNameFor(size, current.jobId, attemptOf(current) + 1) };
}
