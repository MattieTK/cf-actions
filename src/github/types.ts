/** The subset of GitHub payloads we read. Field names follow GitHub's API. */

export type OwnerType = "Organization" | "User";

export interface WorkflowJobEvent {
	readonly action: "queued" | "waiting" | "in_progress" | "completed" | string;
	readonly workflow_job: {
		readonly id: number;
		readonly run_id: number;
		readonly name: string;
		readonly workflow_name?: string | null;
		readonly labels: readonly string[];
		readonly status: string;
		readonly conclusion: string | null;
		readonly runner_name: string | null;
		readonly created_at?: string | null;
		readonly started_at?: string | null;
		readonly completed_at?: string | null;
		readonly html_url?: string | null;
	};
	readonly repository: {
		readonly name: string;
		readonly full_name: string;
		readonly private: boolean;
		readonly owner: { readonly login: string; readonly type: OwnerType | string };
	};
	readonly installation?: { readonly id: number };
}

/** Credentials returned by the App manifest conversion and stored (encrypted) in AppRegistry. */
export interface AppCredentials {
	readonly appId: number;
	readonly slug: string;
	readonly name: string;
	readonly ownerLogin: string;
	readonly ownerType: OwnerType | string;
	readonly htmlUrl: string;
	readonly privateKey: string;
	readonly webhookSecret: string;
}

/** Where a just-in-time runner is registered. */
export type RunnerTarget =
	| { readonly kind: "org"; readonly org: string; readonly installationId: number }
	| { readonly kind: "repo"; readonly owner: string; readonly repo: string; readonly installationId: number };

export interface WebhookDelivery {
	readonly id: number;
	readonly guid: string;
	readonly delivered_at: string;
	readonly redelivery: boolean;
	readonly status_code: number;
	readonly event: string;
	readonly action: string | null;
}
