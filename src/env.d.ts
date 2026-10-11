// `cf workers types` infers Env from cloudflare.config.ts, but a Durable Object binding that names
// its Worker by string (as a Worker must when binding its own classes) comes out untyped. Narrow
// those bindings to the classes they point at so RPC calls are type-checked.
declare namespace Cloudflare {
	interface Env {
		RUNNER_1CPU: DurableObjectNamespace<import("./durable/runner").Runner1Cpu>;
		RUNNER_2CPU: DurableObjectNamespace<import("./durable/runner").Runner2Cpu>;
		RUNNER_4CPU: DurableObjectNamespace<import("./durable/runner").Runner4Cpu>;
		APP_REGISTRY: DurableObjectNamespace<import("./durable/app-registry").AppRegistry>;
		JOB_LEDGER: DurableObjectNamespace<import("./durable/job-ledger").JobLedger>;
	}
}
