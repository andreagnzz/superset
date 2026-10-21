import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchRules } from "@superset/shared/agent-launch-estimator";
import { parseWorkerEnvelope } from "@superset/shared/plan-issues";
import {
	lastAssistantTurn,
	type PlanAgentState,
	type PlanLaunchInput,
	PlanRunInputError,
	PlanRunManager,
	workerPrompt,
} from "./plan-run-manager";
import { PlanRunStore } from "./store";

const RULES = parseLaunchRules(
	JSON.stringify({
		tiers: {
			S: { model: "haiku", effort: "low" },
			M: { model: "sonnet", effort: "high" },
			L: { model: "opus", effort: "high" },
		},
		rules: [],
		escalation: { afterFailures: 1, maxTier: "L" },
	}),
);

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

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function setup(
	dir = mkdtempSync(join(tmpdir(), "plan-runs-")),
	agents = new Map<string, PlanAgentState & { answer?: string }>(),
) {
	dirs.push(dir);
	const launches: PlanLaunchInput[] = [];
	const nudges: string[] = [];
	let clock = 1_000;
	const manager = new PlanRunManager({
		store: new PlanRunStore(dir),
		launch: async (input) => {
			launches.push(input);
			const terminalId = `t-${input.issue.key}-${input.issue.attempts}`;
			agents.set(terminalId, { state: "working" });
			return {
				workspaceId: input.issue.workspaceId ?? `w-${input.issue.key}`,
				terminalId,
			};
		},
		agentState: async (i) =>
			agents.get(i.terminalId ?? "") ?? { state: "gone" },
		readAnswer: async (i) => agents.get(i.terminalId ?? "")?.answer ?? null,
		nudge: async (i) => {
			nudges.push(i.key);
		},
		routingRules: async () => RULES,
		now: () => clock,
	});
	const stop = async (key: string, answer: string) => {
		const run = (await manager.list())[0];
		const terminalId = run?.issues.find((i) => i.key === key)?.terminalId;
		clock += 10;
		agents.set(terminalId ?? "", {
			state: "idle",
			lastEventAt: clock,
			answer,
		});
	};
	const envelope = (key: string, kind: "DONE" | "BLOCKED") =>
		kind === "DONE"
			? `SUPERSET_WORKER_DONE\ntask: ${key}\nsummary: did ${key}`
			: `SUPERSET_WORKER_BLOCKED\ntask: ${key}\nreason: stuck`;
	const statuses = async () =>
		Object.fromEntries(
			((await manager.list())[0]?.issues ?? []).map((i) => [i.key, i.status]),
		);
	const setAgent = (key: string, agent: PlanAgentState & { answer?: string }) =>
		agents.set(`t-${key}-1`, agent);
	const advance = (ms: number) => {
		clock += ms;
	};
	return {
		dir,
		agents,
		manager,
		launches,
		nudges,
		stop,
		envelope,
		statuses,
		setAgent,
		advance,
	};
}

describe("PlanRunManager", () => {
	it("keeps the cap and starts a stacked issue from its parent's branch", async () => {
		const { manager, launches, stop, envelope, statuses } = setup();
		const run = await manager.importRun({
			projectId: "p",
			name: "demo",
			maxParallel: 1,
			issues: [
				issue("A"),
				issue("B"),
				issue("C", { dependsOn: ["A"], stackOn: "A" }),
			],
		});
		await manager.start(run.id);
		await manager.tick();
		expect(launches.map((l) => l.issue.key)).toEqual(["A"]);

		await stop("A", envelope("A", "DONE"));
		await manager.tick();
		expect(launches.map((l) => l.issue.key)).toEqual(["A", "B"]);

		await stop("B", envelope("B", "DONE"));
		await manager.tick();
		expect(launches[2]?.issue.key).toBe("C");
		expect(launches[2]?.baseBranch).toBe("ade/demo/A");

		await stop("C", envelope("C", "DONE"));
		await manager.tick();
		expect(await statuses()).toEqual({ A: "done", B: "done", C: "done" });
		expect((await manager.get(run.id))?.status).toBe("done");
	});

	it("retries a blocked issue once a size up, then fails it and blocks its dependents", async () => {
		const { manager, launches, stop, envelope, statuses } = setup();
		const run = await manager.importRun({
			projectId: "p",
			name: "demo",
			maxParallel: 2,
			issues: [issue("A"), issue("B", { dependsOn: ["A"] })],
		});
		await manager.start(run.id);
		await manager.tick();
		expect(launches[0]?.model).toBe("haiku");

		await stop("A", envelope("A", "BLOCKED"));
		await manager.tick();
		expect(launches[1]?.model).toBe("sonnet");
		expect(launches[1]?.issue.workspaceId).toBe("w-A");
		expect(launches[1]?.prompt).toContain(
			"A previous attempt failed: blocked: stuck",
		);

		await stop("A", envelope("A", "BLOCKED"));
		await manager.tick();
		expect(await statuses()).toEqual({ A: "failed", B: "blocked" });
		expect(launches).toHaveLength(2);
	});

	it("nudges once for a missing envelope and waits for the answer to it", async () => {
		const { manager, launches, nudges, stop } = setup();
		const run = await manager.importRun({
			projectId: "p",
			name: "demo",
			maxParallel: 1,
			issues: [issue("A")],
		});
		await manager.start(run.id);
		await manager.tick();

		await stop("A", "All done, but no envelope.");
		await manager.tick();
		expect(nudges).toEqual(["A"]);
		await manager.tick();
		expect(launches).toHaveLength(1);

		await stop("A", "Still no envelope.");
		await manager.tick();
		expect(launches).toHaveLength(2);
	});

	it("resumes from its files after a restart without starting anything twice", async () => {
		const first = setup();
		const run = await first.manager.importRun({
			projectId: "p",
			name: "demo",
			maxParallel: 2,
			issues: [issue("A"), issue("B"), issue("C", { dependsOn: ["A"] })],
		});
		await first.manager.start(run.id);
		await first.manager.tick();
		expect(first.launches).toHaveLength(2);

		const second = setup(first.dir, first.agents);
		await second.stop("A", second.envelope("A", "DONE"));
		await second.manager.tick();
		expect(second.launches.map((l) => l.issue.key)).toEqual(["C"]);
		expect(await second.statuses()).toEqual({
			A: "done",
			B: "running",
			C: "running",
		});
	});

	it("reads a stale working agent's answer, as after a Stop the host missed", async () => {
		const { manager, launches, statuses, setAgent, advance } = setup();
		const run = await manager.importRun({
			projectId: "p",
			name: "demo",
			maxParallel: 1,
			issues: [issue("A")],
		});
		await manager.start(run.id);
		await manager.tick();
		setAgent("A", {
			state: "working",
			lastEventAt: 1_000,
			answer: "Still going.",
		});
		advance(10 * 60_000);
		await manager.tick();
		expect(await statuses()).toEqual({ A: "running" });
		setAgent("A", {
			state: "working",
			lastEventAt: 1_000,
			answer: "SUPERSET_WORKER_DONE\ntask: A\nsummary: ok",
		});
		await manager.tick();
		expect(await statuses()).toEqual({ A: "done" });
		expect(launches).toHaveLength(1);
	});

	it("rejects an invalid plan on import", async () => {
		const { manager } = setup();
		const imported = manager.importRun({
			projectId: "p",
			name: "demo",
			maxParallel: 1,
			issues: [issue("A", { dependsOn: ["Z"] })],
		});
		await expect(imported).rejects.toBeInstanceOf(PlanRunInputError);
	});
});

it("workerPrompt never reads as the issue's own envelope", () => {
	const prompt = workerPrompt(
		{
			id: "r",
			projectId: "p",
			name: "demo",
			maxParallel: 1,
			status: "running",
			createdAt: 0,
			updatedAt: 0,
			issues: [],
		},
		{ ...issue("A"), size: "S", status: "running", attempts: 1 },
	);
	expect(prompt).toContain("task set to A");
	expect(parseWorkerEnvelope(prompt, "A")).toBeNull();
});

it("lastAssistantTurn keeps only the agent's last answer", () => {
	const transcript =
		"User: Do A. End with SUPERSET_WORKER_DONE\ntask: A\n\nAssistant: Working.\n\nUser: go on\n\nAssistant: Done.\nSUPERSET_WORKER_DONE\ntask: A";
	expect(lastAssistantTurn(transcript)).toBe(
		"Assistant: Done.\nSUPERSET_WORKER_DONE\ntask: A",
	);
	expect(lastAssistantTurn("User: only a prompt")).toBeNull();
});
