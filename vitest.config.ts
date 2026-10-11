import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				// Pure logic and the shell wrapper, in Node.
				test: {
					name: "unit",
					include: ["test/*.test.ts"],
					environment: "node",
				},
			},
			{
				// The storage Durable Objects against real SQLite, inside the Workers runtime. Uses a
				// test-only Wrangler config so the container classes (which need Docker) are not loaded.
				plugins: [cloudflareTest({ wrangler: { configPath: "./test/workers/wrangler.jsonc" } })],
				test: {
					name: "workers",
					include: ["test/workers/*.test.ts"],
				},
			},
		],
	},
});
