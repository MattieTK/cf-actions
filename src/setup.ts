import type { AppSummary, SetupTarget } from "./durable/app-registry";
import { convertManifestCode } from "./github/client";
import { html, page, raw } from "./html";
import { registryStub } from "./launch";
import { buildAppManifest, isValidAppName, isValidLogin, manifestFormAction } from "./manifest";
import { randomToken } from "./crypto";

function appList(apps: AppSummary[]) {
	if (apps.length === 0) return html`<p class="muted">No GitHub Apps registered yet.</p>`;
	return html`<div class="table-wrap"><table>
<thead><tr><th>App</th><th>Owner</th><th>Created</th><th></th></tr></thead>
<tbody>${apps.map(
		(app) => html`<tr>
<td><a href="${app.htmlUrl}">${app.name}</a></td>
<td>${app.ownerLogin} <span class="muted">(${app.ownerType})</span></td>
<td>${new Date(app.createdAt).toISOString().slice(0, 10)}</td>
<td><a href="${app.htmlUrl}/installations/new">Install on repositories</a></td>
</tr>`,
	)}</tbody></table></div>`;
}

export async function setupPage(env: Env): Promise<Response> {
	const apps = await registryStub(env).listApps();
	const suggestedName = `cf-actions-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 34);
	return page(
		"cf-actions setup",
		html`<h1>cf-actions setup</h1>
<p class="muted">Create a private GitHub App connected to this Worker, then install it on the repositories whose jobs should run here.</p>
<h2>Registered Apps</h2>
${appList(apps)}
<h2>Create a GitHub App</h2>
<form class="card" method="post" action="/setup">
<label><input type="radio" name="account" value="user" checked> My personal account</label>
<label><input type="radio" name="account" value="org"> An organisation</label>
<label for="org">Organisation login (only for organisations)</label>
<input type="text" id="org" name="org" placeholder="my-org" autocomplete="off">
<label for="name">App name (must be unique across GitHub, 34 characters at most)</label>
<input type="text" id="name" name="name" value="${suggestedName}" maxlength="34" required>
<p class="muted">Personal accounts: the App asks for repository <code>Administration: write</code>, the only way to register repository runners.
Organisations: it asks only for <code>Self-hosted runners: write</code>. Either way it is private, so only its owner can install it.</p>
<button type="submit">Continue to GitHub</button>
</form>`,
	);
}

export async function startSetup(request: Request, env: Env): Promise<Response> {
	const form = await request.formData();
	const account = String(form.get("account") ?? "user");
	const org = String(form.get("org") ?? "").trim();
	const name = String(form.get("name") ?? "").trim();

	if (!isValidAppName(name)) {
		return page("Invalid name", html`<h1>Invalid App name</h1><p>Use 1–34 letters, numbers, spaces, dots, dashes or underscores.</p><p><a href="/setup">Back</a></p>`, 400);
	}
	if (account === "org" && !isValidLogin(org)) {
		return page("Invalid organisation", html`<h1>Invalid organisation login</h1><p><a href="/setup">Back</a></p>`, 400);
	}

	const target: SetupTarget = account === "org" ? { kind: "org", org } : { kind: "user" };
	const origin = new URL(request.url).origin;
	const state = await registryStub(env).createSetupState(target);
	const manifest = JSON.stringify(buildAppManifest(origin, target, name));

	return page(
		"Continue to GitHub",
		html`<h1>Continue to GitHub</h1>
<p>GitHub will show the App's permissions and ask you to confirm its creation.</p>
<form method="post" action="${manifestFormAction(target, state)}">
<input type="hidden" name="manifest" value="${manifest}">
<button type="submit">Create the App on GitHub</button>
</form>
<script>${raw("document.forms[0].submit();")}</script>`,
	);
}

export async function completeSetup(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) return page("Setup failed", html`<h1>Missing code or state</h1>`, 400);

	const registry = registryStub(env);
	// The state was created behind admin auth and is single-use, so a valid one proves this
	// callback continues a setup an admin started.
	const target = await registry.consumeSetupState(state);
	if (!target) {
		return page("Setup failed", html`<h1>Setup link expired or already used</h1><p><a href="/setup">Start again</a></p>`, 400);
	}

	let creds: Awaited<ReturnType<typeof convertManifestCode>>;
	try {
		creds = await convertManifestCode(code);
	} catch (error) {
		console.error("manifest code exchange failed", error);
		return page(
			"Setup failed",
			html`<h1>Could not finish creating the App</h1>
<p>GitHub may have created the App, but this Worker could not fetch its credentials. Delete the half-created App in your
GitHub settings (Developer settings → GitHub Apps), then <a href="/setup">start again</a>.</p>`,
			502,
		);
	}
	await registry.saveApp(creds);
	return page(
		"App created",
		html`<h1>GitHub App created</h1>
<p><b>${creds.name}</b> is registered for <b>${creds.ownerLogin}</b>.</p>
<p>Next, <a href="${creds.htmlUrl}/installations/new">install it on the repositories</a> whose jobs should run on Cloudflare,
then change their workflows to <code>runs-on: cf-2cpu</code> (or <code>cf-1cpu</code> / <code>cf-4cpu</code>).</p>
<p><a href="/">Status page</a> · <a href="/setup">Setup</a></p>`,
	);
}
