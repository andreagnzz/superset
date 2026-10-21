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
	reviewerPrompt,
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
		roles: { review: { model: "opus", effort: "high" } },
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

const APPROVE = { approve: true, findings: [] };
const REFUSE = {
	approve: false,
	findings: [
		{ file: "src/x.js", line: 3, severity: "blocker", fix: "start at 0" },
	],
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

type FakeAgent = PlanAgentState & { answer?: string };

function setup(
	dir = mkdtempSync(join(tmpdir(), "plan-runs-")),
	agents = new Map<string, FakeAgent>(),
) {
	dirs.push(dir);
	const launches: PlanLaunchInput[] = [];
	const reviewers: { key: string; terminalId: string; model?: string }[] = [];
	const sends: { terminalId?: string; text: string }[] = [];
	const closed: string[] = [];
	const publishes: string[] = [];
	const comments: string[] = [];
	const verdicts = new Map<string, unknown>();
	const baseHeads = new Map<string, string>();
	const prStates = new Map<number, "open" | "merged" | "closed">();
	const restacks: { key: string; onto?: string; upstream: string }[] = [];
	const retargets: { key: string; base?: string }[] = [];
	let restackResult:
		| { ok: true; base: string; baseSha: string }
		| { ok: false; reason: string; detail: string } = {
		ok: true,
		base: "ade/demo/A",
		baseSha: "moved",
	};
	let clock = 1_000;
	let nextPr = 1;
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
		launchReviewer: async ({ issue: i, model }) => {
			const terminalId = `r-${i.key}-${reviewers.length + 1}`;
			reviewers.push({ key: i.key, terminalId, model });
			agents.set(terminalId, { state: "working" });
			return { terminalId };
		},
		agentState: async (t) =>
			agents.get(t.terminalId ?? "") ?? { state: "gone" },
		readAnswer: async (t) => agents.get(t.terminalId ?? "")?.answer ?? null,
		send: async (t, text) => {
			sends.push({ terminalId: t.terminalId, text });
		},
		closeTerminal: async (t) => {
			closed.push(t.terminalId ?? "");
		},
		publish: async ({ issue: i }) => {
			publishes.push(i.key);
			return i.prNumber && i.prUrl
				? { prNumber: i.prNumber, prUrl: i.prUrl }
				: { prNumber: nextPr, prUrl: `https://example.test/pull/${nextPr++}` };
		},
		comment: async (_run, i, body) => {
			comments.push(`${i.key}: ${body.split("\n")[0]}`);
		},
		verdictPath: (run, i, round) => `${run.id}/${i.key}-${round}.json`,
		readVerdict: async (path) => verdicts.get(path) ?? null,
		stackState: async (i) => {
			const baseHead = baseHeads.get(i.key) ?? "base0";
			return { base: i.baseBranch ?? "main", baseHead, mergeBase: "base0" };
		},
		restack: async (i, onto, upstream) => {
			restacks.push({ key: i.key, onto, upstream });
			return restackResult;
		},
		pullRequestState: async (_run, i) =>
			prStates.get(i.prNumber ?? 0) ?? "open",
		retarget: async (_run, i, base) => {
			retargets.push({ key: i.key, base });
		},
		routingRules: async () => RULES,
		now: () => clock,
	});
	const current = async (key: string) =>
		(await manager.list())[0]?.issues.find((i) => i.key === key);
	const idle = (terminalId: string, answer?: string) => {
		clock += 10;
		agents.set(terminalId, {
			state: "idle",
			lastEventAt: clock,
			turnEnded: true,
			answer,
		});
	};
	const stop = async (key: string, answer: string) =>
		idle((await current(key))?.terminalId ?? "", answer);
	const done = (key: string) =>
		stop(key, `SUPERSET_WORKER_DONE\ntask: ${key}\nsummary: did ${key}`);
	const review = async (key: string, verdict: unknown) => {
		const run = (await manager.list())[0];
		const i = await current(key);
		if (verdict !== undefined) {
			verdicts.set(`${run?.id}/${key}-${i?.reviewRound}.json`, verdict);
		}
		idle(i?.reviewerTerminalId ?? "", "REVIEW_WRITTEN");
	};
	const statuses = async () =>
		Object.fromEntries(
			((await manager.list())[0]?.issues ?? []).map((i) => [i.key, i.status]),
		);
	const advance = (ms: number) => {
		clock += ms;
	};
	const finish = async (key: string) => {
		await done(key);
		await manager.tick();
		await review(key, APPROVE);
		await manager.tick();
	};
	return {
		baseHeads,
		prStates,
		restacks,
		retargets,
		finish,
		setRestackResult: (result: typeof restackResult) => {
			restackResult = result;
		},
		dir,
		agents,
		manager,
		launches,
		reviewers,
		sends,
		closed,
		publishes,
		comments,
		current,
		stop,
		done,
		review,
		statuses,
		advance,
	};
}

async function importAndStart(
	manager: PlanRunManager,
	maxParallel: number,
	issues: ReturnType<typeof issue>[],
) {
	const run = await manager.importRun({
		projectId: "p",
		name: "demo",
		maxParallel,
		issues,
	});
	await manager.start(run.id);
	await manager.tick();
	return run;
}

describe("PlanRunManager", () => {
	it("publishes a finished issue, reviews it, then starts the issue stacked on it", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [
			issue("A"),
			issue("C", { dependsOn: ["A"], stackOn: "A" }),
		]);
		expect(h.launches.map((l) => l.issue.key)).toEqual(["A"]);

		await h.done("A");
		await h.manager.tick();
		expect(h.publishes).toEqual(["A"]);
		expect(await h.statuses()).toEqual({ A: "review", C: "queued" });
		expect(h.reviewers[0]?.model).toBe("opus");

		await h.review("A", APPROVE);
		await h.manager.tick();
		expect(h.comments).toEqual(["A: ADE review, round 1: approved"]);
		expect(h.closed).toEqual(["r-A-1"]);
		expect(h.launches[1]?.issue.key).toBe("C");
		expect(h.launches[1]?.baseBranch).toBe("ade/demo/A");

		await h.done("C");
		await h.manager.tick();
		expect((await h.current("C"))?.prNumber).toBe(2);
	});

	it("loops fresh reviewers until the fixed issue is approved", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [issue("A")]);
		await h.done("A");
		await h.manager.tick();

		await h.review("A", REFUSE);
		await h.manager.tick();
		expect(await h.statuses()).toEqual({ A: "running" });
		expect(h.sends.at(-1)?.terminalId).toBe("t-A-1");
		expect(h.sends.at(-1)?.text).toContain("[blocker] src/x.js:3 start at 0");

		// The implementer's old envelope is still its last answer until it replies.
		await h.manager.tick();
		expect(h.publishes).toEqual(["A"]);

		await h.done("A");
		await h.manager.tick();
		expect(h.publishes).toEqual(["A", "A"]);
		expect((await h.current("A"))?.prNumber).toBe(1);
		expect((await h.current("A"))?.reviewerTerminalId).toBe("r-A-2");

		await h.review("A", APPROVE);
		await h.manager.tick();
		expect(await h.statuses()).toEqual({ A: "done" });
		expect(h.comments).toEqual([
			"A: ADE review, round 1: changes requested",
			"A: ADE review, round 2: approved",
		]);
	});

	it("blocks an issue still refused at round 3, and its dependents", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [
			issue("A"),
			issue("B", { dependsOn: ["A"] }),
		]);
		for (let round = 1; round <= 3; round++) {
			await h.done("A");
			await h.manager.tick();
			await h.review("A", REFUSE);
			await h.manager.tick();
		}
		expect(await h.statuses()).toEqual({ A: "blocked", B: "blocked" });
		expect((await h.current("A"))?.error).toBe(
			"review not approved after 3 rounds",
		);
	});

	it("waits for a reviewer's first turn to end, not for its first idle state", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [issue("A")]);
		await h.done("A");
		await h.manager.tick();
		h.agents.set("r-A-1", { state: "idle", lastEventAt: 2_000 });
		await h.manager.tick();
		expect(h.sends).toEqual([]);
		expect(await h.statuses()).toEqual({ A: "review" });
	});

	it("nudges a reviewer once for its verdict, then replaces it", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [issue("A")]);
		await h.done("A");
		await h.manager.tick();

		await h.review("A", undefined);
		await h.manager.tick();
		expect(h.sends.at(-1)).toEqual({
			terminalId: "r-A-1",
			text: "The verdict file is missing. Write it as your instructions say.",
		});

		await h.review("A", "not json");
		await h.manager.tick();
		expect(h.comments).toEqual([
			"A: ADE review, round 1: the reviewer wrote no valid verdict",
		]);
		expect((await h.current("A"))?.reviewerTerminalId).toBe("r-A-2");
		expect(await h.statuses()).toEqual({ A: "review" });
	});

	it("retries a blocked issue once a size up, then fails it and blocks its dependents", async () => {
		const h = setup();
		await importAndStart(h.manager, 2, [
			issue("A"),
			issue("B", { dependsOn: ["A"] }),
		]);
		expect(h.launches[0]?.model).toBe("haiku");

		await h.stop("A", "SUPERSET_WORKER_BLOCKED\ntask: A\nreason: stuck");
		await h.manager.tick();
		expect(h.launches[1]?.model).toBe("sonnet");
		expect(h.launches[1]?.issue.workspaceId).toBe("w-A");
		expect(h.launches[1]?.prompt).toContain(
			"A previous attempt failed: blocked: stuck",
		);

		await h.stop("A", "SUPERSET_WORKER_BLOCKED\ntask: A\nreason: stuck");
		await h.manager.tick();
		expect(await h.statuses()).toEqual({ A: "failed", B: "blocked" });
		expect(h.launches).toHaveLength(2);
	});

	it("nudges once for a missing envelope and waits for the answer to it", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [issue("A")]);

		await h.stop("A", "All done, but no envelope.");
		await h.manager.tick();
		expect(h.sends.map((s) => s.terminalId)).toEqual(["t-A-1"]);
		await h.manager.tick();
		expect(h.launches).toHaveLength(1);

		await h.stop("A", "Still no envelope.");
		await h.manager.tick();
		expect(h.launches).toHaveLength(2);
	});

	it("reads a stale working agent's answer, as after a Stop the host missed", async () => {
		const h = setup();
		await importAndStart(h.manager, 1, [issue("A")]);
		h.agents.set("t-A-1", {
			state: "working",
			lastEventAt: 1_000,
			answer: "Still going.",
		});
		h.advance(10 * 60_000);
		await h.manager.tick();
		expect(await h.statuses()).toEqual({ A: "running" });

		h.agents.set("t-A-1", {
			state: "working",
			lastEventAt: 1_000,
			answer: "SUPERSET_WORKER_DONE\ntask: A\nsummary: ok",
		});
		await h.manager.tick();
		expect(await h.statuses()).toEqual({ A: "review" });
	});

	it("resumes from its files after a restart without starting anything twice", async () => {
		const first = setup();
		await importAndStart(first.manager, 2, [
			issue("A"),
			issue("B"),
			issue("C", { dependsOn: ["A"] }),
		]);
		expect(first.launches).toHaveLength(2);

		const second = setup(first.dir, first.agents);
		await second.done("A");
		await second.manager.tick();
		expect(await second.statuses()).toEqual({
			A: "review",
			B: "running",
			C: "queued",
		});
		expect(second.launches).toHaveLength(0);
	});

	describe("stacks", () => {
		async function doneStack() {
			const h = setup();
			await importAndStart(h.manager, 2, [
				issue("A"),
				issue("B", { dependsOn: ["A"], stackOn: "A" }),
			]);
			await h.finish("A");
			await h.finish("B");
			expect(await h.statuses()).toEqual({ A: "done", B: "done" });
			h.advance(61_000);
			return h;
		}

		it("rebases a done child when its parent's branch moved", async () => {
			const h = await doneStack();
			h.baseHeads.set("B", "moved");
			await h.manager.tick();
			expect(h.restacks).toEqual([
				{ key: "B", onto: "ade/demo/A", upstream: "base0" },
			]);
			expect((await h.current("B"))?.baseSha).toBe("moved");
			expect(h.comments.at(-1)).toBe(
				"B: ADE stack: rebased onto ade/demo/A (moved) after it changed.",
			);
		});

		it("retargets a child onto its parent's base when the parent is merged", async () => {
			const h = await doneStack();
			h.prStates.set(1, "merged");
			h.setRestackResult({ ok: true, base: "main", baseSha: "m1" });
			await h.manager.tick();
			expect(h.restacks).toEqual([
				{ key: "B", onto: undefined, upstream: "base0" },
			]);
			expect(h.retargets).toEqual([{ key: "B", base: undefined }]);
			expect((await h.current("B"))?.baseBranch).toBeUndefined();
			expect(h.comments.at(-1)).toBe(
				"B: ADE stack: #1 was merged; retargeted onto main and rebased.",
			);
		});

		it("leaves an issue alone after its rebase failed", async () => {
			const h = await doneStack();
			h.baseHeads.set("B", "moved");
			h.setRestackResult({
				ok: false,
				reason: "rebase-failed",
				detail: "CONFLICT (content)",
			});
			await h.manager.tick();
			expect((await h.current("B"))?.stackError).toContain("rebase-failed");
			h.advance(61_000);
			await h.manager.tick();
			expect(h.restacks).toHaveLength(1);
		});
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

it("reviewerPrompt names the pull request and the verdict file", () => {
	const prompt = reviewerPrompt(7, "/runs/r/A-round1.json");
	expect(prompt).toContain("`gh pr diff 7`");
	expect(prompt).toContain("Write /runs/r/A-round1.json as:");
});

it("lastAssistantTurn keeps only the agent's last answer", () => {
	const transcript =
		"User: Do A. End with SUPERSET_WORKER_DONE\ntask: A\n\nAssistant: Working.\n\nUser: go on\n\nAssistant: Done.\nSUPERSET_WORKER_DONE\ntask: A";
	expect(lastAssistantTurn(transcript)).toBe(
		"Assistant: Done.\nSUPERSET_WORKER_DONE\ntask: A",
	);
	expect(lastAssistantTurn("User: only a prompt")).toBeNull();
});
