import { requireAdmin } from "./auth";
import { runBackstop } from "./backstop";
import { completeSetup, setupPage, startSetup } from "./setup";
import { statusPage } from "./status";
import { handleWebhook } from "./webhook";

export { AppRegistry } from "./durable/app-registry";
export { JobLedger } from "./durable/job-ledger";
export { Runner1Cpu, Runner2Cpu, Runner4Cpu } from "./durable/runner";

function isSameOrigin(request: Request): boolean {
	const fetchSite = request.headers.get("Sec-Fetch-Site");
	if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";
	const origin = request.headers.get("Origin");
	return origin === null || origin === new URL(request.url).origin;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const { pathname } = new URL(request.url);

	if (pathname === "/webhook") return handleWebhook(request, env, ctx);
	if (pathname === "/healthz") return new Response("ok");
	// Reached by GitHub's redirect; protected by the single-use state instead of basic auth, since
	// browsers do not always resend credentials on a cross-site redirect.
	if (pathname === "/setup/callback" && request.method === "GET") return completeSetup(request, env);

	if (pathname === "/" || pathname === "/setup") {
		const denied = requireAdmin(request, env.ADMIN_TOKEN);
		if (denied) return denied;
		if (pathname === "/") return statusPage(env);
		if (request.method === "POST") {
			// Browsers resend cached basic-auth credentials on cross-site form posts.
			if (!isSameOrigin(request)) return new Response("cross-site request refused", { status: 403 });
			return startSetup(request, env);
		}
		return setupPage(env);
	}

	return new Response("not found", { status: 404 });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await route(request, env, ctx);
		} catch (error) {
			console.error("request failed", error);
			return new Response("internal error", { status: 500 });
		}
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(runBackstop(env));
	},
} satisfies ExportedHandler<Env>;
