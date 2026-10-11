import { verifyWebhookSignature } from "./crypto";
import type { WorkflowJobEvent } from "./github/types";
import { launchRequestFromEvent, ledgerStub, registryStub, runnerStub } from "./launch";
import { routeJob } from "./routing";
import { parseSettings } from "./settings";
import { parseRunnerName, sizeByLabel } from "./sizes";

function text(status: number, body: string): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function timestamp(value: string | null | undefined): number | null {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Receives the App's webhooks. GitHub expects a response within 10 seconds, so container launches
 * continue in the background after we reply; the ledger row written first lets the backstop
 * finish any launch that does not complete.
 */
export async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return text(405, "method not allowed");

	// GitHub names the App a delivery belongs to, which tells us whose secret to verify with.
	const appId = Number(request.headers.get("X-GitHub-Hook-Installation-Target-ID"));
	if (!Number.isSafeInteger(appId) || appId <= 0) return text(400, "missing App ID header");

	const body = await request.text();
	const creds = await registryStub(env).getApp(appId);
	if (!creds) return text(404, "unknown App");
	if (!(await verifyWebhookSignature(creds.webhookSecret, body, request.headers.get("X-Hub-Signature-256")))) {
		return text(401, "bad signature");
	}

	const eventName = request.headers.get("X-GitHub-Event");
	if (eventName === "ping") return text(200, "pong");
	if (eventName !== "workflow_job") return text(202, `ignored event ${eventName}`);

	const event = JSON.parse(body) as WorkflowJobEvent;
	switch (event.action) {
		case "queued":
			return onQueued(event, appId, env, ctx);
		case "in_progress":
			return onInProgress(event, env);
		case "completed":
			return onCompleted(event, env, ctx);
		default:
			return text(202, `ignored action ${event.action}`);
	}
}

async function onQueued(event: WorkflowJobEvent, appId: number, env: Env, ctx: ExecutionContext): Promise<Response> {
	const decision = routeJob(
		{
			labels: event.workflow_job.labels,
			owner: event.repository.owner.login,
			privateRepo: event.repository.private,
		},
		parseSettings(env),
	);
	if (decision.kind === "ignore") return text(202, `ignored: ${decision.reason}`);

	const launch = launchRequestFromEvent(event, decision.size, appId);
	if (!launch) return text(400, "missing installation");

	await ledgerStub(env).recordQueued(launch, event.workflow_job.name, Date.now());
	// Launch even when the row already existed: the launch is idempotent, and a redelivered webhook
	// usually means the previous attempt did not finish.
	ctx.waitUntil(
		runnerStub(env, launch.size, launch.jobId)
			.launch(launch)
			.then((outcome) => console.log(`launch ${launch.runnerName}: ${outcome}`))
			.catch((error: unknown) => console.error(`launch ${launch.runnerName} threw`, error)),
	);
	return text(202, `launching ${launch.runnerName}`);
}

async function onInProgress(event: WorkflowJobEvent, env: Env): Promise<Response> {
	const runner = parseRunnerName(event.workflow_job.runner_name);
	if (!runner) return text(202, "not our runner");
	const startedAt = timestamp(event.workflow_job.started_at) ?? Date.now();
	await Promise.all([
		ledgerStub(env).recordAssigned(
			event.workflow_job.runner_name!,
			event.workflow_job.id,
			event.workflow_job.name,
			startedAt,
		),
		runnerStub(env, runner.size.label, runner.jobId).markAssigned(),
	]);
	return text(202, "recorded");
}

async function onCompleted(event: WorkflowJobEvent, env: Env, ctx: ExecutionContext): Promise<Response> {
	const runner = parseRunnerName(event.workflow_job.runner_name);
	const ourLabel = event.workflow_job.labels.map(sizeByLabel).find((size) => size !== undefined);
	if (!runner && !ourLabel) return text(202, "not our job");

	const { launched } = await ledgerStub(env).recordCompleted({
		runnerName: runner ? event.workflow_job.runner_name : null,
		jobId: event.workflow_job.id,
		jobName: event.workflow_job.name,
		conclusion: event.workflow_job.conclusion,
		startedAt: timestamp(event.workflow_job.started_at),
		completedAt: timestamp(event.workflow_job.completed_at) ?? Date.now(),
	});

	// Cancelled before any runner took it: the runner launched for it is probably idle. Free it now
	// rather than paying for it until the idle timeout.
	if (!runner && ourLabel && launched) {
		ctx.waitUntil(
			runnerStub(env, ourLabel.label, event.workflow_job.id)
				.cancelIfIdle()
				.catch((error: unknown) => console.error(`cancelIfIdle for job ${event.workflow_job.id} failed`, error)),
		);
	}
	return text(202, "recorded");
}
