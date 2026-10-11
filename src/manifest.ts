import type { SetupTarget } from "./durable/app-registry";

/**
 * Builds the GitHub App manifest for the one-click App creation flow
 * (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 *
 * Permissions are the minimum for the target. Organisations get organisation runners, which need
 * only "Self-hosted runners: write". Personal accounts have no organisation runners, so the App
 * needs repository "Administration: write" to register repository runners.
 *
 * The App is private: it can only be installed on the account that owns it, so nobody else can
 * install it and run jobs on this Cloudflare account.
 */
export function buildAppManifest(origin: string, target: SetupTarget, name: string) {
	const permissions =
		target.kind === "org"
			? { organization_self_hosted_runners: "write", actions: "read", metadata: "read" }
			: { administration: "write", actions: "read", metadata: "read" };
	return {
		name,
		url: origin,
		description: "Runs GitHub Actions jobs on Cloudflare Containers.",
		public: false,
		hook_attributes: { url: `${origin}/webhook`, active: true },
		redirect_url: `${origin}/setup/callback`,
		default_permissions: permissions,
		default_events: ["workflow_job"],
	};
}

export function manifestFormAction(target: SetupTarget, state: string): string {
	const base =
		target.kind === "org"
			? `https://github.com/organizations/${encodeURIComponent(target.org)}/settings/apps/new`
			: "https://github.com/settings/apps/new";
	return `${base}?state=${encodeURIComponent(state)}`;
}

// GitHub logins: alphanumerics and single hyphens, at most 39 characters.
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function isValidLogin(login: string): boolean {
	return LOGIN_PATTERN.test(login);
}

/** GitHub App names must be unique across GitHub and at most 34 characters. */
export function isValidAppName(name: string): boolean {
	return name.length >= 1 && name.length <= 34 && /^[\w .-]+$/.test(name);
}
