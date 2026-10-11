import { cloudflareCostUsd, githubCostUsd } from "./cost";
import type { RunnerRecord } from "./durable/job-ledger";
import { html, page } from "./html";
import { ledgerStub } from "./launch";
import { sizeByLabel } from "./sizes";

export interface RunnerCost {
	/** Seconds the container was running (billed by Cloudflare). */
	readonly containerSeconds: number;
	/** Seconds the job itself ran (what GitHub would have billed, rounded up per minute). */
	readonly jobSeconds: number;
	readonly cloudflareMaxUsd: number;
	readonly githubUsd: number;
}

export function runnerCost(record: RunnerRecord, now: number): RunnerCost {
	const size = sizeByLabel(record.size);
	if (!size || record.startedAt === null) {
		return { containerSeconds: 0, jobSeconds: 0, cloudflareMaxUsd: 0, githubUsd: 0 };
	}
	const containerEnd = record.stoppedAt ?? (record.status === "running" ? now : record.startedAt);
	const containerSeconds = Math.max(0, (containerEnd - record.startedAt) / 1000);
	// Only jobs that actually ran would have cost anything on GitHub.
	const jobSeconds =
		record.jobStartedAt !== null && record.jobCompletedAt !== null
			? Math.max(0, (record.jobCompletedAt - record.jobStartedAt) / 1000)
			: 0;
	return {
		containerSeconds,
		jobSeconds,
		cloudflareMaxUsd: cloudflareCostUsd(size, containerSeconds),
		githubUsd: githubCostUsd(size, jobSeconds),
	};
}

export interface CostSummary {
	readonly runners: number;
	readonly jobsCompleted: number;
	readonly containerMinutes: number;
	readonly cloudflareMaxUsd: number;
	readonly githubUsd: number;
}

export function summarise(records: readonly RunnerRecord[], now: number): CostSummary {
	return records.reduce<CostSummary>(
		(total, record) => {
			const cost = runnerCost(record, now);
			return {
				runners: total.runners + 1,
				jobsCompleted: total.jobsCompleted + (record.jobCompletedAt !== null ? 1 : 0),
				containerMinutes: total.containerMinutes + cost.containerSeconds / 60,
				cloudflareMaxUsd: total.cloudflareMaxUsd + cost.cloudflareMaxUsd,
				githubUsd: total.githubUsd + cost.githubUsd,
			};
		},
		{ runners: 0, jobsCompleted: 0, containerMinutes: 0, cloudflareMaxUsd: 0, githubUsd: 0 },
	);
}

export function formatUsd(value: number): string {
	const magnitude = Math.abs(value);
	return `${value < 0 ? "-" : ""}$${magnitude.toFixed(magnitude < 1 ? 4 : 2)}`;
}

export function formatDuration(seconds: number): string {
	const total = Math.round(seconds);
	if (total <= 0) return "–";
	const minutes = Math.floor(total / 60);
	return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`;
}

function statusCell(record: RunnerRecord) {
	const conclusion = record.conclusion ? ` · ${record.conclusion}` : "";
	const cls = record.status === "failed" || record.conclusion === "failure" ? "bad" : record.conclusion === "success" ? "ok" : "";
	return html`<span class="${cls}">${record.status}${conclusion}</span>`;
}

export async function statusPage(env: Env, now = Date.now()): Promise<Response> {
	const ledger = ledgerStub(env);
	const [recent, month] = await Promise.all([
		ledger.listRecent(100),
		ledger.listSince(now - 30 * 24 * 60 * 60_000),
	]);
	const summary = summarise(month, now);
	const saving = summary.githubUsd - summary.cloudflareMaxUsd;

	return page(
		"cf-actions status",
		html`<h1>cf-actions</h1>
<p class="muted">GitHub Actions jobs on Cloudflare Containers. <a href="/setup">Setup</a></p>
<h2>Last 30 days</h2>
<div class="stats">
<div class="card stat"><span class="muted">Runners launched</span><b>${summary.runners}</b></div>
<div class="card stat"><span class="muted">Container time</span><b>${Math.round(summary.containerMinutes)} min</b></div>
<div class="card stat"><span class="muted">Cloudflare, at most</span><b>${formatUsd(summary.cloudflareMaxUsd)}</b></div>
<div class="card stat"><span class="muted">Same jobs on GitHub</span><b>${formatUsd(summary.githubUsd)}</b></div>
<div class="card stat"><span class="muted">Difference</span><b class="${saving >= 0 ? "ok" : "bad"}">${formatUsd(saving)}</b></div>
</div>
<p class="muted">The Cloudflare figure assumes the CPU was busy for the container's whole lifetime, so real cost is lower.
It excludes free allowances and Worker/Durable Object charges (small at CI volumes). GitHub's figure rounds each job up to a whole minute, as GitHub does.</p>
<h2>Recent runners</h2>
<div class="table-wrap"><table>
<thead><tr><th>Created</th><th>Repository</th><th>Job</th><th>Size</th><th>Status</th><th class="num">Container</th><th class="num">Job</th><th class="num">Cloudflare max</th><th class="num">GitHub</th><th>Note</th></tr></thead>
<tbody>${recent.map((record) => {
			const cost = runnerCost(record, now);
			return html`<tr>
<td>${new Date(record.createdAt).toISOString().replace("T", " ").slice(0, 16)}</td>
<td>${record.repoFullName}</td>
<td>${record.assignedJobName ?? record.jobName}</td>
<td>${record.size}</td>
<td>${statusCell(record)}</td>
<td class="num">${formatDuration(cost.containerSeconds)}</td>
<td class="num">${formatDuration(cost.jobSeconds)}</td>
<td class="num">${formatUsd(cost.cloudflareMaxUsd)}</td>
<td class="num">${formatUsd(cost.githubUsd)}</td>
<td class="muted">${record.error ?? record.stopReason ?? ""}</td>
</tr>`;
		})}</tbody></table></div>`,
	);
}
