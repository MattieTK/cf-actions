/** Operator settings, parsed from the `vars` in wrangler.jsonc. */
export interface Settings {
	/** Lower-cased owner logins. Empty means any owner the App is installed on. */
	readonly allowedOwners: ReadonlySet<string>;
	readonly allowPublicRepos: boolean;
	readonly idleTimeoutMs: number;
	readonly maxJobMs: number;
	readonly runnerGroupId: number;
}

export interface SettingsEnv {
	readonly ALLOWED_OWNERS?: string;
	readonly ALLOW_PUBLIC_REPOS?: string;
	readonly IDLE_TIMEOUT_MINUTES?: string;
	readonly MAX_JOB_MINUTES?: string;
	readonly RUNNER_GROUP_ID?: string;
}

const MINUTE_MS = 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseSettings(env: SettingsEnv): Settings {
	const allowedOwners = new Set(
		(env.ALLOWED_OWNERS ?? "")
			.split(",")
			.map((owner) => owner.trim().toLowerCase())
			.filter((owner) => owner.length > 0),
	);
	return {
		allowedOwners,
		allowPublicRepos: (env.ALLOW_PUBLIC_REPOS ?? "").trim().toLowerCase() === "true",
		idleTimeoutMs: positiveInt(env.IDLE_TIMEOUT_MINUTES, 10) * MINUTE_MS,
		maxJobMs: positiveInt(env.MAX_JOB_MINUTES, 360) * MINUTE_MS,
		runnerGroupId: positiveInt(env.RUNNER_GROUP_ID, 1),
	};
}
