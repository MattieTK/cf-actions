export interface WatchdogInput {
	readonly now: number;
	readonly startedAt: number;
	/** Whether we know a job has been assigned to this runner. */
	readonly assigned: boolean;
	readonly idleTimeoutMs: number;
	readonly maxJobMs: number;
}

/**
 * - `continue`: nothing to do yet.
 * - `stop-overdue`: the container has outlived the maximum job time.
 * - `check-idle`: no job seen within the idle timeout. Ask GitHub before stopping, because the
 *   `in_progress` webhook that would have told us may have been lost.
 */
export type WatchdogDecision = "continue" | "stop-overdue" | "check-idle";

export function decideWatchdog(input: WatchdogInput): WatchdogDecision {
	const age = input.now - input.startedAt;
	if (age >= input.maxJobMs) return "stop-overdue";
	if (!input.assigned && age >= input.idleTimeoutMs) return "check-idle";
	return "continue";
}
