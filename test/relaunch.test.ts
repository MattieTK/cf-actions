import { describe, expect, it } from "vitest";
import type { LaunchRequest } from "../src/launch";
import { relaunchRequest, shouldRelaunch, shouldRelaunchAfterIdleStop } from "../src/relaunch";

function request(runnerName: string): LaunchRequest {
	return {
		runnerName,
		size: "cf-2cpu",
		jobId: 777,
		appId: 1,
		installationId: 2,
		owner: "acme",
		ownerType: "Organization",
		repo: "app",
		repoFullName: "acme/app",
	};
}

describe("shouldRelaunch", () => {
	const released = { phase: "stopped", assigned: false } as const;

	it("relaunches a runner that stopped without a job when its job is queued again", () => {
		// For example: approved after the idle watchdog stopped the runner launched before approval.
		expect(shouldRelaunch(released, "queued")).toBe(true);
	});

	it("relaunches when the job's status could not be looked up", () => {
		// An unneeded runner costs one idle timeout; a stranded job waits up to 24 hours.
		expect(shouldRelaunch(released, undefined)).toBe(true);
	});

	it("does not relaunch for a job that is not queued", () => {
		expect(shouldRelaunch(released, "waiting")).toBe(false);
		expect(shouldRelaunch(released, "in_progress")).toBe(false);
		expect(shouldRelaunch(released, "completed")).toBe(false);
		expect(shouldRelaunch(released, null)).toBe(false); // job no longer exists
	});

	it("does not relaunch a runner that ran a job, or one that is still running", () => {
		expect(shouldRelaunch({ phase: "stopped", assigned: true }, "queued")).toBe(false);
		expect(shouldRelaunch({ phase: "running", assigned: false }, "queued")).toBe(false);
		expect(shouldRelaunch({ phase: "launching", assigned: false }, "queued")).toBe(false);
	});
});

describe("shouldRelaunchAfterIdleStop", () => {
	it("relaunches when the job is queued as its idle runner is removed (approved just before the idle check)", () => {
		expect(shouldRelaunchAfterIdleStop("queued")).toBe(true);
	});

	it("does not relaunch on a failed lookup, or for a job still awaiting approval", () => {
		// Relaunching on a failed lookup could start an idle runner every idle timeout until approval.
		expect(shouldRelaunchAfterIdleStop(undefined)).toBe(false);
		expect(shouldRelaunchAfterIdleStop("waiting")).toBe(false);
		expect(shouldRelaunchAfterIdleStop("in_progress")).toBe(false);
		expect(shouldRelaunchAfterIdleStop(null)).toBe(false);
	});
});

describe("relaunchRequest", () => {
	it("moves to the next attempt, keeping everything but the runner name", () => {
		expect(relaunchRequest(request("cf-2cpu-777"), request("cf-2cpu-777"))).toEqual(request("cf-2cpu-777-2"));
		expect(relaunchRequest(request("cf-2cpu-777-2"), request("cf-2cpu-777"))).toEqual(request("cf-2cpu-777-3"));
	});

	it("reuses an attempt the backstop is already re-driving instead of allocating another", () => {
		expect(relaunchRequest(request("cf-2cpu-777"), request("cf-2cpu-777-2"))).toEqual(request("cf-2cpu-777-2"));
	});
});
