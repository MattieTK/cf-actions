import type { RunnerSize } from "./sizes";

// https://developers.cloudflare.com/containers/pricing/ (Oct 2026). CPU is billed on active
// usage; memory and disk on what the instance type provisions. Free allowances are ignored.
export const CLOUDFLARE_RATES = {
	vcpuSecondUsd: 0.00002,
	memoryGiBSecondUsd: 0.0000025,
	diskGBSecondUsd: 0.00000007,
} as const;

/**
 * Upper-bound Cloudflare cost for a container that ran `seconds`, assuming `cpuUtilisation`
 * (0–1) of its vCPUs were busy throughout. We cannot observe real CPU usage, so the status page
 * uses 1 (the worst case) to keep comparisons conservative.
 */
export function cloudflareCostUsd(size: RunnerSize, seconds: number, cpuUtilisation = 1): number {
	if (!(seconds > 0)) return 0;
	const utilisation = Math.min(Math.max(cpuUtilisation, 0), 1);
	const perSecond =
		size.vcpu * utilisation * CLOUDFLARE_RATES.vcpuSecondUsd +
		size.memoryGiB * CLOUDFLARE_RATES.memoryGiBSecondUsd +
		size.diskGB * CLOUDFLARE_RATES.diskGBSecondUsd;
	return seconds * perSecond;
}

/** What GitHub would have charged: every job is rounded up to a whole minute. */
export function githubCostUsd(size: RunnerSize, jobSeconds: number): number {
	if (!(jobSeconds > 0)) return 0;
	return Math.ceil(jobSeconds / 60) * size.github.perMinuteUsd;
}
