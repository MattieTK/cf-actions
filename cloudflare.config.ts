import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index" with { type: "cf-worker" };

// One Container application per machine size: Cloudflare fixes the instance type per application.
// All three run the same image. See src/sizes.ts for the label each size answers to.
function runnerContainer(name: string, instanceType: "standard-2" | "standard-3" | "standard-4") {
	return defineContainer({
		name,
		image: { dockerfile: "./container/Dockerfile" },
		instanceType,
		maxInstances: 10,
		// Do not replace a running job's container during a deploy for up to 6 hours.
		rollout: { activeGracePeriod: 21600 },
	});
}

const runner1Cpu = runnerContainer("cf-actions-runner1cpu", "standard-2");
const runner2Cpu = runnerContainer("cf-actions-runner2cpu", "standard-3");
const runner4Cpu = runnerContainer("cf-actions-runner4cpu", "standard-4");

export default defineConfig({
	// The account comes from CLOUDFLARE_ACCOUNT_ID (or the only account you are logged in to).
	worker: {
		name: "cf-actions",
		compatibilityDate: "2026-10-01",
		entrypoint,
		observability: { enabled: true },

		// The backstop: redeliver failed webhooks, re-drive stuck launches, reconcile lost stops.
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],

		exports: {
			Runner1Cpu: exports.durableObject({ storage: "sqlite", container: runner1Cpu }),
			Runner2Cpu: exports.durableObject({ storage: "sqlite", container: runner2Cpu }),
			Runner4Cpu: exports.durableObject({ storage: "sqlite", container: runner4Cpu }),
			AppRegistry: exports.durableObject({ storage: "sqlite" }),
			JobLedger: exports.durableObject({ storage: "sqlite" }),
		},

		env: {
			// Comma-separated GitHub owners (users or orgs) allowed to use these runners. Empty = any
			// owner the GitHub App is installed on (the App is private, so only its owner can install it).
			ALLOWED_OWNERS: bindings.text(""),
			// Self-hosted runners on public repos let anyone who opens a PR run code on them.
			ALLOW_PUBLIC_REPOS: bindings.text("false"),
			// Stop a runner that has not picked up a job after this long.
			IDLE_TIMEOUT_MINUTES: bindings.text("10"),
			// Hard limit on a single container's lifetime (GitHub-hosted runners also cap jobs at 6h).
			MAX_JOB_MINUTES: bindings.text("360"),
			// Runner group for organisation runners. 1 is the "Default" group.
			RUNNER_GROUP_ID: bindings.text("1"),

			// Password for the /setup and status pages, and the key that encrypts GitHub App
			// credentials at rest. Upload with `cf deploy --secrets-file`.
			ADMIN_TOKEN: bindings.secret(),
			ENCRYPTION_KEY: bindings.secret(),

			RUNNER_1CPU: bindings.durableObject({ worker: "cf-actions", exportName: "Runner1Cpu" }),
			RUNNER_2CPU: bindings.durableObject({ worker: "cf-actions", exportName: "Runner2Cpu" }),
			RUNNER_4CPU: bindings.durableObject({ worker: "cf-actions", exportName: "Runner4Cpu" }),
			APP_REGISTRY: bindings.durableObject({ worker: "cf-actions", exportName: "AppRegistry" }),
			JOB_LEDGER: bindings.durableObject({ worker: "cf-actions", exportName: "JobLedger" }),
		},
	},
	containers: [runner1Cpu, runner2Cpu, runner4Cpu],
});
