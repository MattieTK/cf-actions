import { Container, type StopParams } from "@cloudflare/containers";
import { GitHubApiError, GitHubApp, type JobStatus, isBusyRunnerError } from "../github/client";
import type { RunnerTarget } from "../github/types";
import { type LaunchRequest, ledgerStub, registryStub, runnerTargetFor } from "../launch";
import { relaunchRequest, shouldRelaunch, shouldRelaunchAfterIdleStop } from "../relaunch";
import { parseSettings } from "../settings";
import { DEFAULT_RUNNER_LABELS, type SizeLabel } from "../sizes";
import { decideWatchdog } from "../watchdog";

/**
 * Phases of one job's runner, stored in the Durable Object:
 *
 *   (none) ──mint JIT──▶ launching ──container started──▶ running ──container exited──▶ stopped
 *                          │  ▲                              ▲                              │
 *                          │  └─ start failed: stays launching, retried by the backstop     │
 *                          └─ container found running without a record: adopted ─┘          │
 *                          ▲                                                                │
 *                          └── job queued again, never ran one: relaunch as next attempt ───┘
 *
 * The ledger row is always written before the phase changes, so if a ledger write fails the
 * phase still describes the old state and the next onStop/launch/reconcile writes it again.
 */
interface LaunchState {
	readonly request: LaunchRequest;
	readonly phase: "launching" | "running" | "stopped";
	readonly runnerId?: number;
	readonly startedAt?: number;
	readonly assigned: boolean;
	/** The registration was deleted as idle and the container is being stopped. */
	readonly released?: boolean;
	readonly stoppedAt?: number;
	readonly exitCode?: number | null;
	readonly stopReason?: string;
}

export type LaunchOutcome = "started" | "already-started" | "retry-later" | "gave-up";

const STATE_KEY = "cf-actions:launch";
// Exit code the runner uses (with ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1) when GitHub
// refuses its version. The image needs rebuilding with a newer runner.
const RUNNER_VERSION_DEPRECATED_EXIT_CODE = 7;
// Keep retrying while GitHub keeps the job queued (it gives up after 24 hours); a job usually
// waits this long only because every instance of its size is busy.
const LAUNCH_RETRY_WINDOW_MS = 3 * 60 * 60_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNameConflict(error: unknown): boolean {
	return (
		error instanceof GitHubApiError &&
		(error.status === 409 || (error.status === 422 && /already exists/i.test(error.body)))
	);
}

/**
 * One instance per GitHub job (named `job-<jobId>`), so duplicate or redelivered webhooks can
 * never start a second container. Mints a just-in-time runner registration, starts the
 * container with it, and watches over the container until it exits.
 */
abstract class RunnerContainer extends Container<Env> {
	abstract readonly size: SizeLabel;

	// Nothing ever sends requests to a CI runner, so `sleepAfter` is not an inactivity timeout here.
	// It is how often the base class calls onActivityExpired(), which we use as a watchdog tick.
	override sleepAfter = "2m";
	override enableInternet = true;

	private launching: Promise<LaunchOutcome> | undefined;

	private async loadState(): Promise<LaunchState | undefined> {
		return this.ctx.storage.get<LaunchState>(STATE_KEY);
	}

	private async saveState(state: LaunchState): Promise<void> {
		await this.ctx.storage.put(STATE_KEY, state);
	}

	private async github(appId: number): Promise<GitHubApp> {
		const creds = await registryStub(this.env).getApp(appId);
		if (!creds) throw new Error(`GitHub App ${appId} is not registered`);
		return new GitHubApp(creds);
	}

	/** Best-effort ledger annotation; never blocks the action it describes. */
	private async noteStopReason(state: LaunchState, reason: string): Promise<void> {
		await ledgerStub(this.env)
			.noteStopReason(state.request.runnerName, reason)
			.catch((error: unknown) => console.error(`noting stop reason for ${state.request.runnerName}`, error));
	}

	/** Idempotent: safe to call for every webhook delivery and every backstop pass. */
	async launch(request: LaunchRequest): Promise<LaunchOutcome> {
		const existing = await this.loadState();
		// Calls to GitHub yield the Durable Object's input gate, so coalesce concurrent launches.
		const coalesce = (work: () => Promise<LaunchOutcome>) => {
			this.launching ??= work().finally(() => {
				this.launching = undefined;
			});
			return this.launching;
		};

		// GitHub sends `queued` before an environment approval and again after it. A runner that
		// stopped without running a job (the idle watchdog stopped it while the job awaited
		// approval) may need a successor.
		if (existing?.phase === "stopped" && !existing.assigned) return coalesce(() => this.relaunch(existing, request));
		if (existing?.phase === "running" && existing.released && !existing.assigned) {
			// Its container is being stopped as idle, and a new one cannot start alongside it. Record
			// the next attempt; the backstop launches it once the container has exited.
			await this.recordRelaunch(existing, relaunchRequest(existing.request, request));
			return "retry-later";
		}
		if (existing?.phase === "running" || existing?.phase === "stopped") {
			// The ledger may have missed the last transition; repeat it (the writes are idempotent).
			await this.syncLedger(existing).catch((error: unknown) =>
				console.error(`ledger sync for ${request.runnerName} failed`, errorMessage(error)),
			);
			return "already-started";
		}
		// A relaunch stores its request before starting; keep using it rather than the first attempt's.
		return coalesce(() => this.doLaunch(existing?.request ?? request));
	}

	/**
	 * Starts the next attempt for a job whose runner stopped without running it, if GitHub says
	 * the job is queued. Otherwise drops any relaunch the backstop recorded for it.
	 */
	private async relaunch(existing: LaunchState, incoming: LaunchRequest): Promise<LaunchOutcome> {
		const next = relaunchRequest(existing.request, incoming);
		const job = await this.lookUpJob(existing.request);
		const status = job === undefined ? undefined : (job?.status ?? null);
		if (!shouldRelaunch(existing, status)) {
			await ledgerStub(this.env).cancelPending(next.runnerName, `job is no longer queued (${status ?? "gone"})`);
			await this.syncLedger(existing).catch((error: unknown) =>
				console.error(`ledger sync for ${existing.request.runnerName} failed`, errorMessage(error)),
			);
			return "already-started";
		}
		await this.recordRelaunch(existing, next, job?.name);
		// Defensive: the stopped phase is recorded when the container exits, so this should not happen.
		if (this.ctx.container?.running) return "retry-later";
		console.log(`relaunching ${existing.request.runnerName} as ${next.runnerName} (job ${status ?? "status unknown"})`);
		await this.saveState({ request: next, phase: "launching", assigned: false });
		return this.doLaunch(next);
	}

	/** Writes the ledger row for a relaunch first, so the backstop finishes it if this one stops short. */
	private async recordRelaunch(existing: LaunchState, next: LaunchRequest, jobName?: string): Promise<void> {
		const ledger = ledgerStub(this.env);
		const name = jobName ?? (await ledger.get(existing.request.runnerName))?.jobName ?? `job ${next.jobId}`;
		await ledger.recordQueued(next, name, Date.now());
	}

	/** The job's status from GitHub: null if it no longer exists, undefined if the lookup failed. */
	private async lookUpJob(request: LaunchRequest): Promise<JobStatus | null | undefined> {
		try {
			const github = await this.github(request.appId);
			return await github.getJob(request, request.jobId);
		} catch (error) {
			console.error(`job lookup for ${request.runnerName} failed`, errorMessage(error));
			return undefined;
		}
	}

	private async syncLedger(state: LaunchState): Promise<void> {
		const ledger = ledgerStub(this.env);
		if (state.runnerId !== undefined && state.startedAt !== undefined) {
			await ledger.markRunning(state.request.runnerName, state.runnerId, state.startedAt);
		}
		if (state.phase === "stopped") {
			await ledger.markStopped(state.request.runnerName, {
				stoppedAt: state.stoppedAt ?? Date.now(),
				exitCode: state.exitCode ?? null,
				reason: state.stopReason ?? "exit",
			});
		}
	}

	private async doLaunch(request: LaunchRequest): Promise<LaunchOutcome> {
		const ledger = ledgerStub(this.env);
		const now = Date.now();
		const attempt = await ledger.markLaunchAttempt(request.runnerName, now);
		const prior = await this.loadState();

		// An earlier attempt started the container but was interrupted before recording it. Adopt it
		// rather than replacing it: its runner may already be running a job.
		if (prior?.runnerId !== undefined && this.ctx.container?.running) {
			await this.adopt(prior);
			return "started";
		}

		const target = runnerTargetFor(request);
		let github: GitHubApp | undefined;
		let runnerId: number | undefined;
		try {
			github = await this.github(request.appId);
			// A previous attempt registered a runner but its container never started. Runner names
			// must be unique, so remove that registration first.
			if (prior?.runnerId !== undefined) await github.deleteRunner(target, prior.runnerId);

			const jit = await this.registerRunner(github, target, request);
			runnerId = jit.runnerId;
			await this.saveState({ request, phase: "launching", runnerId, assigned: false });

			await this.start({ envVars: { JIT_CONFIG: jit.encodedJitConfig } });

			// markAssigned may have landed while start() was awaiting.
			const current = await this.loadState();
			const running: LaunchState = {
				request,
				phase: "running",
				runnerId,
				startedAt: Date.now(),
				assigned: current?.assigned ?? false,
			};
			await this.recordRunning(running);
			return "started";
		} catch (error) {
			const giveUp = !attempt || now - attempt.createdAt > LAUNCH_RETRY_WINDOW_MS;
			console.error(`launch ${request.runnerName} failed (attempt ${attempt?.attempts ?? "?"})`, errorMessage(error));
			await ledger.markLaunchFailed(request.runnerName, errorMessage(error), giveUp);
			if (giveUp && github && runnerId !== undefined) {
				await github.deleteRunner(target, runnerId).catch(() => undefined);
			}
			return giveUp ? "gave-up" : "retry-later";
		}
	}

	private async registerRunner(github: GitHubApp, target: RunnerTarget, request: LaunchRequest) {
		const settings = parseSettings(this.env);
		const labels = [...DEFAULT_RUNNER_LABELS, this.size];
		// Repository runners always belong to the default group; groups are an organisation feature.
		const group = target.kind === "org" ? settings.runnerGroupId : 1;
		try {
			return await github.generateJitConfig(target, request.runnerName, labels, group);
		} catch (error) {
			// A registration with this name exists but its ID was never stored (the Durable Object was
			// evicted between minting and saving). Remove it and try once more.
			if (!isNameConflict(error)) throw error;
			const orphan = await github.findRunnerByName(target, request.runnerName);
			if (orphan === undefined) throw error;
			await github.deleteRunner(target, orphan);
			return github.generateJitConfig(target, request.runnerName, labels, group);
		}
	}

	private async recordRunning(state: LaunchState): Promise<void> {
		const { cancelled } = await ledgerStub(this.env).markRunning(
			state.request.runnerName,
			state.runnerId!,
			state.startedAt!,
		);
		await this.saveState(state);
		// The job was cancelled while we were starting. Free the runner unless it already took
		// another job with the same labels.
		if (cancelled && !state.assigned) await this.stopIfIdle(state, "job-cancelled");
	}

	private async adopt(state: LaunchState): Promise<void> {
		console.log(`adopting running container for ${state.request.runnerName}`);
		await this.recordRunning({ ...state, phase: "running", startedAt: state.startedAt ?? Date.now() });
	}

	/** Called when an `in_progress` webhook names this runner. */
	async markAssigned(): Promise<void> {
		const state = await this.loadState();
		if (state && !state.assigned) await this.saveState({ ...state, assigned: true });
	}

	/**
	 * Called when the job this runner was launched for is cancelled before starting. The runner may
	 * still have picked up another job with the same labels, so it is only stopped if idle.
	 */
	async cancelIfIdle(): Promise<boolean> {
		const state = await this.loadState();
		if (state?.phase !== "running" || state.assigned) return false;
		return this.stopIfIdle(state, "job-cancelled");
	}

	/** Watchdog tick, driven by the base class alarm loop every `sleepAfter` while running. */
	override async onActivityExpired(): Promise<void> {
		const state = await this.loadState();
		if (!state || state.phase === "stopped") {
			// A container with no live launch record should not exist; nothing will ever use it.
			await this.stop();
			return;
		}
		if (state.phase === "launching") {
			// Started, but the launch that started it never recorded it (and is no longer running).
			if (!this.launching && state.runnerId !== undefined) await this.adopt(state);
			return;
		}
		if (state.startedAt === undefined) return;

		const settings = parseSettings(this.env);
		const decision = decideWatchdog({
			now: Date.now(),
			startedAt: state.startedAt,
			assigned: state.assigned,
			idleTimeoutMs: settings.idleTimeoutMs,
			maxJobMs: settings.maxJobMs,
		});
		if (decision === "stop-overdue") {
			await this.stop();
			await this.noteStopReason(state, "max-runtime");
		} else if (decision === "check-idle") {
			await this.stopIfIdle(state, "idle-timeout");
		}
	}

	/**
	 * Stops the container only if GitHub confirms the runner is not running a job. The
	 * registration is deleted before stopping: once it is gone GitHub cannot assign new work, and
	 * GitHub refuses to delete a runner that is mid-job, which closes the race with assignment.
	 */
	private async stopIfIdle(state: LaunchState, reason: string): Promise<boolean> {
		if (state.runnerId === undefined) return false;
		const target = runnerTargetFor(state.request);
		try {
			const github = await this.github(state.request.appId);
			const runner = await github.getRunner(target, state.runnerId);
			if (runner?.busy) {
				await this.saveState({ ...state, assigned: true });
				return false;
			}
			await github.deleteRunner(target, state.runnerId);
		} catch (error) {
			if (isBusyRunnerError(error)) {
				// Busy after all: it picked up a job between the two calls.
				await this.saveState({ ...state, assigned: true });
				return false;
			}
			// Cannot tell whether it is safe to stop (including other 422s, such as rate limiting);
			// try again on the next tick.
			console.error(`idle check for ${state.request.runnerName} failed`, errorMessage(error));
			return false;
		}
		// Until onStop records the stop, a `queued` webhook for this job must not count it as running.
		await this.saveState({ ...state, released: true });
		await this.noteStopReason(state, reason);
		await this.stop();
		if (reason === "idle-timeout") await this.relaunchIfStillQueued(state);
		return true;
	}

	/**
	 * After removing an idle runner: if its job was approved just before the idle check, the second
	 * `queued` webhook found this runner still alive, so record the next attempt for the backstop.
	 */
	private async relaunchIfStillQueued(state: LaunchState): Promise<void> {
		const job = await this.lookUpJob(state.request);
		if (!shouldRelaunchAfterIdleStop(job === undefined ? undefined : (job?.status ?? null))) return;
		await this.recordRelaunch(state, relaunchRequest(state.request, state.request), job?.name).catch((error: unknown) =>
			console.error(`recording relaunch for ${state.request.runnerName} failed`, errorMessage(error)),
		);
	}

	override async onStop(params: StopParams): Promise<void> {
		const reason =
			params.exitCode === RUNNER_VERSION_DEPRECATED_EXIT_CODE ? "runner version too old: redeploy" : params.reason;
		await this.recordStopped(params.exitCode, reason, Date.now());
	}

	private async recordStopped(exitCode: number | null, reason: string, stoppedAt: number): Promise<void> {
		const state = await this.loadState();
		// A container that exits while still `launching` failed to start; the launch path records
		// that attempt and the backstop retries it.
		if (!state || state.phase === "launching") return;

		const stopped: LaunchState =
			state.phase === "stopped" ? state : { ...state, phase: "stopped", stoppedAt, exitCode, stopReason: reason };
		await this.syncLedger(stopped);
		if (state.phase === "stopped") return;
		await this.saveState(stopped);

		// Ephemeral runners deregister themselves after a job. One that never ran a job, or crashed,
		// leaves an offline registration behind.
		if (!state.assigned && state.runnerId !== undefined) {
			try {
				const github = await this.github(state.request.appId);
				await github.deleteRunner(runnerTargetFor(state.request), state.runnerId);
			} catch (error) {
				console.error(`cleanup of ${state.request.runnerName} failed`, errorMessage(error));
			}
		}
	}

	/**
	 * Backstop for the ledger: records a stop that was never observed (or whose ledger write
	 * failed), and stops a container that somehow outlived its watchdog.
	 */
	async reconcile(): Promise<"running" | "stopped"> {
		const state = await this.loadState();
		if (this.ctx.container?.running) {
			const maxJobMs = parseSettings(this.env).maxJobMs;
			if (state?.startedAt === undefined || Date.now() - state.startedAt <= maxJobMs) return "running";
			await this.destroy();
			await this.recordStopped(null, "max-runtime", Date.now());
			return "stopped";
		}
		// The base class records when the container last changed state, which is a closer stop time
		// than now for a stop we never observed.
		const containerState = await this.getState();
		await this.recordStopped(null, "lost", containerState.lastChange || Date.now());
		return "stopped";
	}
}

export class Runner1Cpu extends RunnerContainer {
	readonly size = "cf-1cpu";
}

export class Runner2Cpu extends RunnerContainer {
	readonly size = "cf-2cpu";
}

export class Runner4Cpu extends RunnerContainer {
	readonly size = "cf-4cpu";
}
