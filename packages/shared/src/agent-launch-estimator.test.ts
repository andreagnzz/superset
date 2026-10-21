import { describe, expect, it } from "bun:test";
import {
	escalateSize,
	estimateAgentLaunch,
	parseLaunchRules,
} from "./agent-launch-estimator";

const RULES = parseLaunchRules(
	JSON.stringify({
		tiers: {
			S: { model: "haiku", effort: "low" },
			M: { model: "sonnet", effort: "high" },
			XL: { model: "opus", effort: "xhigh" },
		},
		roles: { review: { model: "opus", effort: "high" } },
		rules: [
			{ match: "typo|readme", tier: "S" },
			{ match: "migration|security", tier: "XL" },
		],
		fallbackTier: "M",
		escalation: { afterFailures: 1, maxTier: "XL" },
	}),
);

const estimate = (input: {
	prompt: string;
	size?: string;
	role?: string;
	presetId?: string;
}) => estimateAgentLaunch({ presetId: "claude", ...input }, RULES);

describe("estimateAgentLaunch", () => {
	it("routes a prompt by the first matching rule", () => {
		expect(estimate({ prompt: "fix typo in README" })).toEqual({
			model: "haiku",
			effort: "low",
			reason: "rule /typo|readme/ -> S",
		});
	});

	it("falls back to the fallback tier", () => {
		expect(estimate({ prompt: "write the parser" })).toMatchObject({
			model: "sonnet",
			effort: "high",
			reason: "fallback M",
		});
	});

	it("prefers a role, then a size, over the prompt rules", () => {
		expect(estimate({ prompt: "fix typo", role: "review" })?.model).toBe(
			"opus",
		);
		expect(estimate({ prompt: "fix typo", size: "XL" })?.effort).toBe("xhigh");
	});

	it("leaves other presets alone", () => {
		expect(estimate({ prompt: "fix typo", presetId: "codex" })).toBeNull();
	});
});

describe("parseLaunchRules", () => {
	it("refuses an unknown effort and a rule naming a missing tier", () => {
		expect(() =>
			parseLaunchRules(
				'{"tiers":{"S":{"model":"haiku","effort":"x"}},"rules":[]}',
			),
		).toThrow("tiers.S.effort");
		expect(() =>
			parseLaunchRules(
				'{"tiers":{"S":{"model":"haiku","effort":"low"}},"rules":[{"match":"a","tier":"Z"}]}',
			),
		).toThrow("rules[0].tier");
	});
});

it("escalateSize goes one tier up per failed attempt, up to the cap", () => {
	expect(escalateSize(RULES, "S", 1)).toBe("S");
	expect(escalateSize(RULES, "S", 2)).toBe("M");
	expect(escalateSize(RULES, "M", 9)).toBe("XL");
});
