import { describe, expect, it } from "vitest";
import { requireAdmin } from "../src/auth";
import { escapeHtml, html, raw } from "../src/html";
import { buildAppManifest, isValidAppName, isValidLogin, manifestFormAction } from "../src/manifest";

describe("buildAppManifest", () => {
	const origin = "https://cf-actions.example.workers.dev";

	it("asks organisations only for the self-hosted runners permission", () => {
		const manifest = buildAppManifest(origin, { kind: "org", org: "acme" }, "cf-actions-acme");
		expect(manifest.default_permissions).toEqual({
			organization_self_hosted_runners: "write",
			actions: "read",
			metadata: "read",
		});
		expect(manifest).toMatchObject({
			public: false,
			default_events: ["workflow_job"],
			hook_attributes: { url: `${origin}/webhook`, active: true },
			redirect_url: `${origin}/setup/callback`,
		});
	});

	it("asks personal accounts for repository administration", () => {
		const manifest = buildAppManifest(origin, { kind: "user" }, "cf-actions-me");
		expect(manifest.default_permissions).toEqual({ administration: "write", actions: "read", metadata: "read" });
	});

	it("targets the right GitHub page", () => {
		expect(manifestFormAction({ kind: "user" }, "s1")).toBe("https://github.com/settings/apps/new?state=s1");
		expect(manifestFormAction({ kind: "org", org: "acme" }, "s/2")).toBe(
			"https://github.com/organizations/acme/settings/apps/new?state=s%2F2",
		);
	});

	it("validates logins and App names", () => {
		expect(isValidLogin("acme-corp")).toBe(true);
		expect(isValidLogin("-acme")).toBe(false);
		expect(isValidLogin("a--b")).toBe(false);
		expect(isValidLogin("acme/../x")).toBe(false);
		expect(isValidAppName("cf-actions 1")).toBe(true);
		expect(isValidAppName("x".repeat(35))).toBe(false);
		expect(isValidAppName("<script>")).toBe(false);
	});
});

describe("requireAdmin", () => {
	const withAuth = (value?: string) =>
		new Request("https://x/", value ? { headers: { Authorization: value } } : undefined);
	const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

	it("lets the right password through with any username", () => {
		expect(requireAdmin(withAuth(basic("anyone", "s3cret")), "s3cret")).toBeNull();
	});

	it("challenges missing or wrong credentials", () => {
		expect(requireAdmin(withAuth(), "s3cret")?.status).toBe(401);
		expect(requireAdmin(withAuth(basic("admin", "nope")), "s3cret")?.status).toBe(401);
		expect(requireAdmin(withAuth("Basic !!!"), "s3cret")?.status).toBe(401);
	});

	it("refuses to run without a configured token", () => {
		expect(requireAdmin(withAuth(basic("admin", "")), "")?.status).toBe(503);
	});
});

describe("html", () => {
	it("escapes interpolated values but not raw fragments", () => {
		const name = `<img src=x onerror="alert(1)">`;
		expect(html`<p>${name}</p>${raw("<br>")}`.value).toBe(`<p>${escapeHtml(name)}</p><br>`);
		expect(escapeHtml(name)).not.toContain("<");
	});

	it("joins arrays of fragments", () => {
		expect(html`<ul>${["a", "<b>"].map((item) => html`<li>${item}</li>`)}</ul>`.value).toBe(
			"<ul><li>a</li><li>&lt;b&gt;</li></ul>",
		);
	});
});
