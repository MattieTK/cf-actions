import { DurableObject } from "cloudflare:workers";
import { decryptString, deriveEncryptionKey, encryptString, randomToken } from "../crypto";
import type { AppCredentials } from "../github/types";

/** Public details of a registered App, safe to show on the setup page. */
export interface AppSummary {
	readonly appId: number;
	readonly slug: string;
	readonly name: string;
	readonly ownerLogin: string;
	readonly ownerType: string;
	readonly htmlUrl: string;
	readonly createdAt: number;
}

export type SetupTarget = { readonly kind: "user" } | { readonly kind: "org"; readonly org: string };

const SETUP_STATE_TTL_MS = 60 * 60_000;

/**
 * Singleton (named "default") holding the GitHub Apps created through /setup. Private keys and
 * webhook secrets are encrypted with ENCRYPTION_KEY: Durable Object storage can be browsed from
 * the Cloudflare dashboard, Worker secrets cannot.
 */
export class AppRegistry extends DurableObject<Env> {
	private keyPromise: Promise<CryptoKey> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS apps (
					app_id INTEGER PRIMARY KEY,
					slug TEXT NOT NULL,
					name TEXT NOT NULL,
					owner_login TEXT NOT NULL,
					owner_type TEXT NOT NULL,
					html_url TEXT NOT NULL,
					secrets TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS setup_states (
					state TEXT PRIMARY KEY,
					target TEXT NOT NULL,
					expires_at INTEGER NOT NULL
				);
			`);
		});
	}

	private key(): Promise<CryptoKey> {
		this.keyPromise ??= deriveEncryptionKey(this.env.ENCRYPTION_KEY);
		return this.keyPromise;
	}

	async saveApp(creds: AppCredentials): Promise<void> {
		const secrets = await encryptString(
			await this.key(),
			JSON.stringify({ privateKey: creds.privateKey, webhookSecret: creds.webhookSecret }),
		);
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO apps (app_id, slug, name, owner_login, owner_type, html_url, secrets, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			creds.appId,
			creds.slug,
			creds.name,
			creds.ownerLogin,
			creds.ownerType,
			creds.htmlUrl,
			secrets,
			Date.now(),
		);
	}

	async getApp(appId: number): Promise<AppCredentials | null> {
		const row = this.ctx.storage.sql
			.exec<{
				app_id: number;
				slug: string;
				name: string;
				owner_login: string;
				owner_type: string;
				html_url: string;
				secrets: string;
			}>("SELECT * FROM apps WHERE app_id = ?", appId)
			.toArray()[0];
		if (!row) return null;
		const secrets = JSON.parse(await decryptString(await this.key(), row.secrets)) as {
			privateKey: string;
			webhookSecret: string;
		};
		return {
			appId: row.app_id,
			slug: row.slug,
			name: row.name,
			ownerLogin: row.owner_login,
			ownerType: row.owner_type,
			htmlUrl: row.html_url,
			...secrets,
		};
	}

	async listApps(): Promise<AppSummary[]> {
		return this.ctx.storage.sql
			.exec<{
				app_id: number;
				slug: string;
				name: string;
				owner_login: string;
				owner_type: string;
				html_url: string;
				created_at: number;
			}>("SELECT app_id, slug, name, owner_login, owner_type, html_url, created_at FROM apps ORDER BY created_at")
			.toArray()
			.map((row) => ({
				appId: row.app_id,
				slug: row.slug,
				name: row.name,
				ownerLogin: row.owner_login,
				ownerType: row.owner_type,
				htmlUrl: row.html_url,
				createdAt: row.created_at,
			}));
	}

	async deleteApp(appId: number): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM apps WHERE app_id = ?", appId);
	}

	/** Single-use, short-lived `state` for the manifest flow, so callbacks cannot be forged. */
	async createSetupState(target: SetupTarget): Promise<string> {
		const now = Date.now();
		const state = randomToken();
		this.ctx.storage.sql.exec("DELETE FROM setup_states WHERE expires_at < ?", now);
		this.ctx.storage.sql.exec(
			"INSERT INTO setup_states (state, target, expires_at) VALUES (?, ?, ?)",
			state,
			JSON.stringify(target),
			now + SETUP_STATE_TTL_MS,
		);
		return state;
	}

	async consumeSetupState(state: string): Promise<SetupTarget | null> {
		const row = this.ctx.storage.sql
			.exec<{ target: string; expires_at: number }>("SELECT target, expires_at FROM setup_states WHERE state = ?", state)
			.toArray()[0];
		this.ctx.storage.sql.exec("DELETE FROM setup_states WHERE state = ?", state);
		if (!row || row.expires_at < Date.now()) return null;
		return JSON.parse(row.target) as SetupTarget;
	}
}
