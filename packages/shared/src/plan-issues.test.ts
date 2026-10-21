import { describe, expect, it } from "bun:test";
import {
	checkPlanIssues,
	checkReviewVerdict,
	dependentKeys,
	parseWorkerEnvelope,
	readyIssueKeys,
} from "./plan-issues";

const issue = (key: string, extra: Record<string, unknown> = {}) => ({
	key,
	title: `Issue ${key}`,
	prompt: `Do ${key}`,
	size: "S",
	dependsOn: [],
	stackOn: null,
	files: ["src/x.js"],
	acceptance: ["works"],
	verify: ["npm test"],
	...extra,
});

describe("checkPlanIssues", () => {
	it("accepts a stacked graph and orders parents first", () => {
		const { errors, order } = checkPlanIssues([
			issue("C", { dependsOn: ["A"], stackOn: "A" }),
			issue("A"),
		]);
		expect(errors).toEqual([]);
		expect(order).toEqual(["A", "C"]);
	});

	it("reports cycles, unknown dependencies, XL and a stack outside dependsOn", () => {
		const { errors } = checkPlanIssues([
			issue("A", { dependsOn: ["B"] }),
			issue("B", { dependsOn: ["A", "Z"], stackOn: "Q" }),
			issue("C", { size: "XL" }),
		]);
		expect(errors).toContain("issue B: unknown dependency Z");
		expect(errors).toContain("issue B: stackOn Q must also be in dependsOn");
		expect(errors).toContain("issue C: size XL is too big, split it");
		expect(errors).toContain("dependency cycle among: A, B");
	});
});

it("readyIssueKeys and dependentKeys follow the dependency graph", () => {
	const { issues } = checkPlanIssues([
		issue("A"),
		issue("B", { dependsOn: ["A"] }),
		issue("C", { dependsOn: ["B"] }),
		issue("D"),
	]);
	const status: Record<string, string> = {
		A: "done",
		B: "queued",
		C: "queued",
		D: "running",
	};
	expect(readyIssueKeys(issues, (key) => status[key] ?? "queued")).toEqual([
		"B",
	]);
	expect(dependentKeys(issues, "A").sort()).toEqual(["B", "C"]);
});

describe("parseWorkerEnvelope", () => {
	it("reads the last envelope for the key", () => {
		const text = [
			"SUPERSET_WORKER_BLOCKED",
			"task: A",
			"reason: old",
			"",
			"⏺ Done.",
			"  SUPERSET_WORKER_DONE",
			"  task: A",
			"  summary: added slugify",
			"  files: src/slugify.js",
		].join("\n");
		expect(parseWorkerEnvelope(text, "A")).toEqual({
			kind: "done",
			summary: "added slugify",
		});
	});

	it("ignores envelopes for other keys and answers null without one", () => {
		const text = "SUPERSET_WORKER_DONE\ntask: B\nsummary: x";
		expect(parseWorkerEnvelope(text, "A")).toBeNull();
		expect(parseWorkerEnvelope("no envelope here", "A")).toBeNull();
	});

	it("reads a blocked envelope's reason", () => {
		const text = "SUPERSET_WORKER_BLOCKED\ntask: A\nreason: needs a token";
		expect(parseWorkerEnvelope(text, "A")).toEqual({
			kind: "blocked",
			reason: "needs a token",
		});
	});
});

it("checkReviewVerdict refuses an approval beside a blocking finding", () => {
	const finding = { file: "a.js", line: 3, severity: "major", fix: "guard" };
	expect(
		checkReviewVerdict({ approve: true, findings: [finding] }).verdict,
	).toBeNull();
	expect(
		checkReviewVerdict({ approve: false, findings: [finding] }).verdict
			?.findings,
	).toHaveLength(1);
	expect(
		checkReviewVerdict({ approve: true, findings: [] }).verdict?.approve,
	).toBe(true);
	expect(checkReviewVerdict({ approve: "yes" }).errors).toContain(
		"approve must be a boolean",
	);
});
