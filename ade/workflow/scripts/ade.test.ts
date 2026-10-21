import { describe, expect, test } from "bun:test";
import {
	checkIssues,
	checkVerdict,
	countActive,
	readyKeys,
	roleFor,
	tierFor,
} from "./ade";

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

const ROUTING = JSON.stringify({
	tiers: {
		S: { model: "haiku", effort: "low" },
		M: { model: "sonnet", effort: "high" },
		L: { model: "opus", effort: "high" },
		XL: { model: "opus", effort: "xhigh" },
	},
	roles: { review: { model: "opus", effort: "high" } },
	subagents: { "*": "rules-or-parent" },
	rules: [],
	escalation: { afterFailures: 1, maxTier: "XL" },
});

describe("checkIssues", () => {
	test("accepts a stacked graph and orders parents first", () => {
		const { errors, order } = checkIssues([
			issue("C", { dependsOn: ["A"], stackOn: "A" }),
			issue("A"),
			issue("B"),
		]);
		expect(errors).toEqual([]);
		expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
	});

	test("reports duplicates, unknown and self dependencies", () => {
		const { errors } = checkIssues([
			issue("A", { dependsOn: ["A", "Z"] }),
			issue("A"),
		]);
		expect(errors).toContain("issue A: duplicate key");
		expect(errors).toContain("issue A: depends on itself");
		expect(errors).toContain("issue A: unknown dependency Z");
	});

	test("reports a cycle", () => {
		const { errors } = checkIssues([
			issue("A", { dependsOn: ["B"] }),
			issue("B", { dependsOn: ["A"] }),
		]);
		expect(errors).toContain("dependency cycle among: A, B");
	});

	test("refuses XL, a stack outside dependsOn and an empty verify", () => {
		const { errors } = checkIssues([
			issue("A", { size: "XL" }),
			issue("B", { stackOn: "C" }),
			issue("C", { verify: [" "] }),
		]);
		expect(errors).toContain("issue A: size XL is too big, split it");
		expect(errors).toContain("issue B: stackOn C must also be in dependsOn");
		expect(errors).toContain("issue C: verify needs at least one command");
	});
});

test("readyKeys waits for every dependency and skips started issues", () => {
	const { issues } = checkIssues([
		issue("A"),
		issue("B"),
		issue("C", { dependsOn: ["A", "B"] }),
	]);
	expect(readyKeys(issues, { done: [], active: ["A"], failed: [] })).toEqual([
		"B",
	]);
	expect(readyKeys(issues, { done: ["A"], active: [], failed: ["B"] })).toEqual(
		[],
	);
	expect(
		readyKeys(issues, { done: ["A", "B"], active: [], failed: [] }),
	).toEqual(["C"]);
});

test("tierFor goes one tier up per failed attempt, up to the cap", () => {
	expect(tierFor(ROUTING, "S", 1)).toEqual({
		tier: "S",
		model: "haiku",
		effort: "low",
	});
	expect(tierFor(ROUTING, "S", 2).tier).toBe("M");
	expect(tierFor(ROUTING, "L", 5).tier).toBe("XL");
	expect(roleFor(ROUTING, "review")).toEqual({ model: "opus", effort: "high" });
});

test("checkVerdict refuses an approval with a blocking finding", () => {
	const finding = { file: "a.js", line: 3, severity: "major", fix: "guard" };
	expect(
		checkVerdict({ approve: true, findings: [finding] }).verdict,
	).toBeNull();
	expect(
		checkVerdict({ approve: false, findings: [finding] }).verdict?.findings,
	).toHaveLength(1);
	expect(
		checkVerdict({
			approve: true,
			findings: [{ ...finding, severity: "minor" }],
		}).verdict?.approve,
	).toBe(true);
});

test("countActive counts starting and working agents of the run only", () => {
	const snapshot = {
		workspaces: [
			{
				name: "run1-A",
				terminals: [
					{ agent: { state: "working" } },
					{ agent: { state: "idle" } },
				],
			},
			{ name: "run1-B", terminals: [{ agent: { state: "starting" } }] },
			{ name: "other", terminals: [{ agent: { state: "working" } }] },
			{ name: "run1-C", terminals: [{ agent: null }] },
		],
	};
	expect(countActive(snapshot, "run1-")).toBe(2);
});
