import { expect, type TestBody, test } from "claude-code/testing";

// Mirrors the parts of ../routing.json each case reads.
const ROUTING = JSON.stringify({
	version: 1,
	tiers: {
		S: { model: "haiku", effort: "low" },
		XL: { model: "opus", effort: "xhigh" },
	},
	roles: {
		plan: { model: "opus", effort: "xhigh" },
		explore: { model: "haiku", effort: "low" },
	},
	subagents: { Explore: "explore", Plan: "plan", "*": "rules-or-parent" },
	rules: [
		{ match: "typo|rename|bump|lint|format|readme|changelog", tier: "S" },
		{
			match: "migration|concurren|race condition|security|auth|architecture",
			tier: "XL",
		},
	],
});

// Stands in for the engine: the routing file, and a spawn and an Agent call
// that answer with the model and effort they were given.
function engine(on: Parameters<TestBody>[1], routing = ROUTING) {
	on("fs.read", () => ({ value: routing }));
	on("agent.spawn", (_, e) => ({ model: e.model ?? "caller" }));
	on("tool.call", (_, e) => ({
		result: e.tool === "Agent" ? (e.effort ?? "caller") : undefined,
	}));
}

const routed = async (
	$: Parameters<TestBody>[0],
	subagentType: string,
	prompt: string,
) => {
	const spawn = await $.agent.spawn({ prompt, subagentType, model: "sonnet" });
	const call = await $.tool.call({
		tool: "Agent",
		description: "probe",
		prompt,
		subagent_type: subagentType,
	});
	return { model: spawn.model, effort: call.result };
};

test("an Explore subagent runs on haiku at low effort", async ($, on) => {
	engine(on);
	expect(await routed($, "Explore", "find the parser")).toEqual({
		model: "haiku",
		effort: "low",
	});
});

test("a Plan subagent runs on opus at xhigh effort", async ($, on) => {
	engine(on);
	expect(await routed($, "Plan", "plan the refactor")).toEqual({
		model: "opus",
		effort: "xhigh",
	});
});

test("a small task matches the S rule", async ($, on) => {
	engine(on);
	expect(await routed($, "general-purpose", "Fix the typo in README")).toEqual({
		model: "haiku",
		effort: "low",
	});
});

test("a risky task matches the XL rule", async ($, on) => {
	engine(on);
	expect(
		await routed($, "general-purpose", "Write the users table MIGRATION"),
	).toEqual({ model: "opus", effort: "xhigh" });
});

test("a task no rule matches keeps the caller's choice", async ($, on) => {
	engine(on);
	expect(await routed($, "general-purpose", "write the parser")).toEqual({
		model: "sonnet",
		effort: "caller",
	});
});

test("a fork keeps the caller's effort", async ($, on) => {
	engine(on);
	const call = await $.tool.call({
		tool: "Agent",
		description: "probe",
		prompt: "Fix the typo in README",
		subagent_type: "fork",
	});
	expect(call.result).toBe("caller");
});

test("an invalid routing.json routes nothing", async ($, on) => {
	engine(on, JSON.stringify({ tiers: { S: { model: "haiku", effort: "x" } } }));
	expect(await routed($, "Explore", "find the parser")).toEqual({
		model: "sonnet",
		effort: "caller",
	});
});
