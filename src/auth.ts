import { constantTimeEqualStrings } from "./crypto";

/**
 * HTTP basic auth for the admin pages: any username, password = ADMIN_TOKEN. Returns a response
 * to send when the request is not authorised, or null to carry on.
 */
export function requireAdmin(request: Request, adminToken: string | undefined): Response | null {
	if (!adminToken) {
		return new Response("ADMIN_TOKEN is not configured. Upload it with `cf deploy --secrets-file <file>`.", {
			status: 503,
		});
	}
	const header = request.headers.get("Authorization") ?? "";
	if (header.startsWith("Basic ")) {
		let decoded = "";
		try {
			decoded = atob(header.slice("Basic ".length));
		} catch {
			// Malformed base64 falls through to the challenge below.
		}
		const password = decoded.slice(decoded.indexOf(":") + 1);
		if (decoded.includes(":") && constantTimeEqualStrings(password, adminToken)) return null;
	}
	return new Response("Authentication required", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="cf-actions", charset="UTF-8"' },
	});
}
