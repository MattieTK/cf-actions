import { describe, expect, it } from "vitest";
import { selectRedeliveries } from "../src/backstop";
import type { WebhookDelivery } from "../src/github/types";

const now = Date.parse("2026-10-11T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function delivery(overrides: Partial<WebhookDelivery>): WebhookDelivery {
	return {
		id: 1,
		guid: "g1",
		delivered_at: minutesAgo(1),
		redelivery: false,
		status_code: 200,
		event: "workflow_job",
		action: "queued",
		...overrides,
	};
}

describe("selectRedeliveries", () => {
	it("redelivers a failed workflow_job delivery", () => {
		expect(selectRedeliveries([delivery({ id: 10, status_code: 500 })], now)).toEqual([10]);
	});

	it("skips deliveries that later succeeded", () => {
		const attempts = [
			delivery({ id: 11, status_code: 200, redelivery: true, delivered_at: minutesAgo(1) }),
			delivery({ id: 10, status_code: 502, delivered_at: minutesAgo(3) }),
		];
		expect(selectRedeliveries(attempts, now)).toEqual([]);
	});

	it("redelivers from the newest failed attempt", () => {
		const attempts = [
			delivery({ id: 10, status_code: 502, delivered_at: minutesAgo(3) }),
			delivery({ id: 11, status_code: 0, redelivery: true, delivered_at: minutesAgo(1) }),
		];
		expect(selectRedeliveries(attempts, now)).toEqual([11]);
	});

	it("gives up after the maximum number of attempts", () => {
		const attempts = [1, 2, 3].map((id) => delivery({ id, status_code: 500, delivered_at: minutesAgo(id) }));
		expect(selectRedeliveries(attempts, now)).toEqual([]);
	});

	it("ignores old deliveries and other events", () => {
		const deliveries = [
			delivery({ id: 1, status_code: 500, delivered_at: minutesAgo(45) }),
			delivery({ id: 2, guid: "g2", status_code: 500, event: "installation" }),
		];
		expect(selectRedeliveries(deliveries, now)).toEqual([]);
	});
});
