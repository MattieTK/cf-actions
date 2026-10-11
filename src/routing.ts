import type { Settings } from "./settings";
import { DEFAULT_RUNNER_LABELS, type RunnerSize, sizeByLabel } from "./sizes";

export interface JobToRoute {
	readonly labels: readonly string[];
	readonly owner: string;
	readonly privateRepo: boolean;
}

export type RouteDecision =
	| { readonly kind: "accept"; readonly size: RunnerSize }
	| { readonly kind: "ignore"; readonly reason: string };

const GENERIC_LABELS = new Set(DEFAULT_RUNNER_LABELS.map((label) => label.toLowerCase()));

/**
 * Decides whether a queued job is ours to run. A job is only accepted when one of our runners
 * would actually match its labels; otherwise we would start containers that never get work.
 */
export function routeJob(job: JobToRoute, settings: Settings): RouteDecision {
	const sizes: RunnerSize[] = [];
	const unknown: string[] = [];
	for (const label of job.labels) {
		const size = sizeByLabel(label);
		if (size) sizes.push(size);
		else if (!GENERIC_LABELS.has(label.toLowerCase())) unknown.push(label);
	}

	if (sizes.length === 0) return { kind: "ignore", reason: "no cf-* size label" };
	if (sizes.length > 1) return { kind: "ignore", reason: "more than one cf-* size label" };
	if (unknown.length > 0) return { kind: "ignore", reason: `unsupported labels: ${unknown.join(", ")}` };
	if (!job.privateRepo && !settings.allowPublicRepos) {
		return { kind: "ignore", reason: "public repository (set ALLOW_PUBLIC_REPOS to allow)" };
	}
	if (settings.allowedOwners.size > 0 && !settings.allowedOwners.has(job.owner.toLowerCase())) {
		return { kind: "ignore", reason: `owner ${job.owner} is not in ALLOWED_OWNERS` };
	}
	return { kind: "accept", size: sizes[0]! };
}
