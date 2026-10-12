/**
 * Machine sizes a workflow can ask for with `runs-on`. Cloudflare fixes the instance type per
 * container class, so each size maps to its own Durable Object binding (see wrangler.jsonc).
 */
export type SizeLabel = "cf-1cpu" | "cf-2cpu" | "cf-4cpu";

export type RunnerBinding = "RUNNER_1CPU" | "RUNNER_2CPU" | "RUNNER_4CPU";

export interface RunnerSize {
	readonly label: SizeLabel;
	readonly binding: RunnerBinding;
	readonly instanceType: string;
	readonly vcpu: number;
	readonly memoryGiB: number;
	readonly diskGB: number;
	/** The GitHub-hosted runner a job of this size would otherwise use, for cost comparison. */
	readonly github: { readonly name: string; readonly perMinuteUsd: number };
}

// GitHub prices: https://docs.github.com/en/billing/reference/actions-runner-pricing (Oct 2026).
export const SIZES: readonly RunnerSize[] = [
	{
		label: "cf-1cpu",
		binding: "RUNNER_1CPU",
		instanceType: "standard-2",
		vcpu: 1,
		memoryGiB: 6,
		diskGB: 12,
		github: { name: "ubuntu-slim (1 core)", perMinuteUsd: 0.002 },
	},
	{
		label: "cf-2cpu",
		binding: "RUNNER_2CPU",
		instanceType: "standard-3",
		vcpu: 2,
		memoryGiB: 8,
		diskGB: 16,
		github: { name: "Linux 2-core", perMinuteUsd: 0.006 },
	},
	{
		label: "cf-4cpu",
		binding: "RUNNER_4CPU",
		instanceType: "standard-4",
		vcpu: 4,
		memoryGiB: 12,
		diskGB: 20,
		github: { name: "Linux 4-core", perMinuteUsd: 0.012 },
	},
];

export function sizeByLabel(label: string): RunnerSize | undefined {
	const normalised = label.toLowerCase();
	return SIZES.find((size) => size.label === normalised);
}

/** Labels every runner registers with, in addition to its size label. */
export const DEFAULT_RUNNER_LABELS = ["self-hosted", "Linux", "X64"] as const;

/**
 * Runner names encode the size and the job that triggered the launch, so an `in_progress`
 * webhook (which names the runner, not the launch) can be traced back to its Durable Object.
 * A job launched again (for example, approved after its first runner was stopped as idle) gets
 * a suffixed name per attempt, because GitHub needs unique runner names and the ledger keeps one
 * row per runner.
 */
export function runnerNameFor(size: RunnerSize, jobId: number, attempt = 1): string {
	return attempt > 1 ? `${size.label}-${jobId}-${attempt}` : `${size.label}-${jobId}`;
}

export function parseRunnerName(
	name: string | null | undefined,
): { size: RunnerSize; jobId: number; attempt: number } | undefined {
	const match = /^(cf-[124]cpu)-(\d+)(?:-([2-9]|[1-9]\d+))?$/.exec(name ?? "");
	if (!match) return undefined;
	const size = sizeByLabel(match[1]!);
	const jobId = Number(match[2]);
	if (!size || !Number.isSafeInteger(jobId)) return undefined;
	return { size, jobId, attempt: match[3] ? Number(match[3]) : 1 };
}

/** Durable Object name for the runner launched for a job. */
export function runnerObjectName(jobId: number): string {
	return `job-${jobId}`;
}
