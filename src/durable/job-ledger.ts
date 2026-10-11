import { DurableObject } from "cloudflare:workers";
import type { LaunchRequest } from "../launch";

/**
 * - `pending`: accepted from a webhook, container not (yet) started. The backstop re-drives these.
 * - `running`: container started.
 * - `stopped`: container exited (normally after its one job).
 * - `failed`: launching gave up after repeated errors.
 * - `cancelled`: the job was cancelled before any container started.
 */
export type RunnerStatus = "pending" | "running" | "stopped" | "failed" | "cancelled";

export interface RunnerRecord extends LaunchRequest {
	readonly jobName: string;
	readonly status: RunnerStatus;
	readonly createdAt: number;
	readonly launchAttempts: number;
	readonly runnerId: number | null;
	readonly startedAt: number | null;
	readonly stoppedAt: number | null;
	readonly exitCode: number | null;
	readonly stopReason: string | null;
	readonly assignedJobId: number | null;
	readonly assignedJobName: string | null;
	readonly jobStartedAt: number | null;
	readonly jobCompletedAt: number | null;
	readonly conclusion: string | null;
	readonly error: string | null;
}

interface Row extends Record<string, SqlStorageValue> {
	runner_name: string;
	size: string;
	job_id: number;
	job_name: string;
	app_id: number;
	installation_id: number;
	owner: string;
	owner_type: string;
	repo: string;
	repo_full_name: string;
	status: string;
	created_at: number;
	launch_attempts: number;
	runner_id: number | null;
	started_at: number | null;
	stopped_at: number | null;
	exit_code: number | null;
	stop_reason: string | null;
	assigned_job_id: number | null;
	assigned_job_name: string | null;
	job_started_at: number | null;
	job_completed_at: number | null;
	conclusion: string | null;
	error: string | null;
}

function toRecord(row: Row): RunnerRecord {
	return {
		runnerName: row.runner_name,
		size: row.size as RunnerRecord["size"],
		jobId: row.job_id,
		jobName: row.job_name,
		appId: row.app_id,
		installationId: row.installation_id,
		owner: row.owner,
		ownerType: row.owner_type,
		repo: row.repo,
		repoFullName: row.repo_full_name,
		status: row.status as RunnerStatus,
		createdAt: row.created_at,
		launchAttempts: row.launch_attempts,
		runnerId: row.runner_id,
		startedAt: row.started_at,
		stoppedAt: row.stopped_at,
		exitCode: row.exit_code,
		stopReason: row.stop_reason,
		assignedJobId: row.assigned_job_id,
		assignedJobName: row.assigned_job_name,
		jobStartedAt: row.job_started_at,
		jobCompletedAt: row.job_completed_at,
		conclusion: row.conclusion,
		error: row.error,
	};
}

/**
 * Singleton (named "default") record of every runner we launched. It feeds the status page and
 * the backstop. Keyed by runner, not job: GitHub may hand a job to any idle runner with
 * matching labels, so the runner launched for job A can end up running job B.
 */
export class JobLedger extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS runners (
					runner_name TEXT PRIMARY KEY,
					size TEXT NOT NULL,
					job_id INTEGER NOT NULL,
					job_name TEXT NOT NULL,
					app_id INTEGER NOT NULL,
					installation_id INTEGER NOT NULL,
					owner TEXT NOT NULL,
					owner_type TEXT NOT NULL,
					repo TEXT NOT NULL,
					repo_full_name TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					launch_attempts INTEGER NOT NULL DEFAULT 0,
					last_attempt_at INTEGER,
					runner_id INTEGER,
					started_at INTEGER,
					stopped_at INTEGER,
					exit_code INTEGER,
					stop_reason TEXT,
					assigned_job_id INTEGER,
					assigned_job_name TEXT,
					job_started_at INTEGER,
					job_completed_at INTEGER,
					conclusion TEXT,
					error TEXT
				);
				CREATE INDEX IF NOT EXISTS runners_status_created ON runners (status, created_at);
				CREATE INDEX IF NOT EXISTS runners_created ON runners (created_at);
				CREATE INDEX IF NOT EXISTS runners_job ON runners (job_id);
			`);
		});
	}

	private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
		return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
	}

	/** Returns false when the runner was already recorded (a duplicate or redelivered webhook). */
	async recordQueued(request: LaunchRequest, jobName: string, now: number): Promise<boolean> {
		const cursor = this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO runners
			 (runner_name, size, job_id, job_name, app_id, installation_id, owner, owner_type, repo, repo_full_name, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			request.runnerName,
			request.size,
			request.jobId,
			jobName,
			request.appId,
			request.installationId,
			request.owner,
			request.ownerType,
			request.repo,
			request.repoFullName,
			now,
		);
		return cursor.rowsWritten > 0;
	}

	async get(runnerName: string): Promise<RunnerRecord | null> {
		const row = this.sql<Row>("SELECT * FROM runners WHERE runner_name = ?", runnerName)[0];
		return row ? toRecord(row) : null;
	}

	/** Counts a launch attempt. Returns the new total and when the row was created, or null if
	 * there is no row (for example, it was pruned). */
	async markLaunchAttempt(runnerName: string, now: number): Promise<{ attempts: number; createdAt: number } | null> {
		const row = this.sql<{ launch_attempts: number; created_at: number }>(
			`UPDATE runners SET launch_attempts = launch_attempts + 1, last_attempt_at = ?
			 WHERE runner_name = ? RETURNING launch_attempts, created_at`,
			now,
			runnerName,
		)[0];
		return row ? { attempts: row.launch_attempts, createdAt: row.created_at } : null;
	}

	/**
	 * Records a started container. A row that was cancelled in the meantime keeps its status, and
	 * the caller is told so it can stop the runner if it is idle.
	 */
	async markRunning(runnerName: string, runnerId: number, startedAt: number): Promise<{ cancelled: boolean }> {
		const row = this.sql<{ status: string }>(
			`UPDATE runners SET runner_id = ?, started_at = COALESCE(started_at, ?), error = NULL,
			 status = CASE WHEN status IN ('pending', 'failed') THEN 'running' ELSE status END
			 WHERE runner_name = ? RETURNING status`,
			runnerId,
			startedAt,
			runnerName,
		)[0];
		return { cancelled: row?.status === "cancelled" };
	}

	async markLaunchFailed(runnerName: string, error: string, giveUp: boolean): Promise<void> {
		this.sql(
			"UPDATE runners SET status = ?, error = ? WHERE runner_name = ? AND status = 'pending'",
			giveUp ? "failed" : "pending",
			error.slice(0, 1000),
			runnerName,
		);
	}

	async markStopped(
		runnerName: string,
		stop: { stoppedAt: number; exitCode: number | null; reason: string },
	): Promise<void> {
		// Idempotent: callers retry this until the Runner's own state says it is recorded.
		this.sql(
			`UPDATE runners SET stopped_at = ?, exit_code = ?, stop_reason = COALESCE(stop_reason, ?),
			 status = CASE WHEN status = 'cancelled' THEN status ELSE 'stopped' END
			 WHERE runner_name = ? AND stopped_at IS NULL`,
			stop.stoppedAt,
			stop.exitCode,
			stop.reason,
			runnerName,
		);
	}

	/** Records why we are about to stop a container, before the stop itself is observed. */
	async noteStopReason(runnerName: string, reason: string): Promise<void> {
		this.sql("UPDATE runners SET stop_reason = ? WHERE runner_name = ?", reason, runnerName);
	}

	async recordAssigned(runnerName: string, jobId: number, jobName: string, startedAt: number): Promise<void> {
		this.sql(
			"UPDATE runners SET assigned_job_id = ?, assigned_job_name = ?, job_started_at = ? WHERE runner_name = ?",
			jobId,
			jobName,
			startedAt,
			runnerName,
		);
	}

	async recordCompleted(event: {
		runnerName: string | null;
		jobId: number;
		jobName: string;
		conclusion: string | null;
		startedAt: number | null;
		completedAt: number;
	}): Promise<{ launched: boolean }> {
		if (event.runnerName) {
			this.sql(
				`UPDATE runners SET assigned_job_id = COALESCE(assigned_job_id, ?), assigned_job_name = COALESCE(assigned_job_name, ?),
				 job_started_at = COALESCE(job_started_at, ?), job_completed_at = ?, conclusion = ? WHERE runner_name = ?`,
				event.jobId,
				event.jobName,
				event.startedAt,
				event.completedAt,
				event.conclusion,
				event.runnerName,
			);
		}
		// Cancelled while still queued: stop the backstop from launching a runner for it.
		this.sql(
			"UPDATE runners SET status = 'cancelled', conclusion = ? WHERE job_id = ? AND status = 'pending'",
			event.conclusion,
			event.jobId,
		);
		const launched = this.sql("SELECT 1 FROM runners WHERE job_id = ? LIMIT 1", event.jobId).length > 0;
		return { launched };
	}

	async listRecent(limit: number): Promise<RunnerRecord[]> {
		return this.sql<Row>("SELECT * FROM runners ORDER BY created_at DESC LIMIT ?", limit).map(toRecord);
	}

	async listSince(since: number, limit = 5000): Promise<RunnerRecord[]> {
		return this.sql<Row>("SELECT * FROM runners WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?", since, limit).map(
			toRecord,
		);
	}

	/**
	 * Pending rows older than `createdBefore` that are due another launch attempt. Retries back off
	 * from one minute, doubling per attempt, up to 15 minutes, so a job waiting for capacity keeps
	 * being retried without hammering GitHub when something is persistently wrong.
	 */
	async listStuckPending(createdBefore: number, now: number, limit = 25): Promise<RunnerRecord[]> {
		return this.sql<Row>(
			`SELECT * FROM runners WHERE status = 'pending' AND created_at < ?
			 AND (last_attempt_at IS NULL OR last_attempt_at + MIN(60000 << MIN(MAX(launch_attempts - 1, 0), 4), 900000) <= ?)
			 ORDER BY created_at LIMIT ?`,
			createdBefore,
			now,
			limit,
		).map(toRecord);
	}

	async listOverdueRunning(startedBefore: number, limit = 25): Promise<RunnerRecord[]> {
		return this.sql<Row>(
			"SELECT * FROM runners WHERE status = 'running' AND started_at < ? ORDER BY started_at LIMIT ?",
			startedBefore,
			limit,
		).map(toRecord);
	}

	async prune(createdBefore: number): Promise<number> {
		return this.ctx.storage.sql.exec("DELETE FROM runners WHERE created_at < ?", createdBefore).rowsWritten;
	}
}
