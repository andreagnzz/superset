import { randomUUID } from "node:crypto";
import {
	escalateSize,
	estimateAgentLaunch,
	type LaunchRules,
} from "@superset/shared/agent-launch-estimator";
import {
	checkPlanIssues,
	dependentKeys,
	parseWorkerEnvelope,
	readyIssueKeys,
} from "@superset/shared/plan-issues";
import type { PlanRun, PlanRunIssue, PlanRunStore } from "./store";

const MAX_ATTEMPTS = 2;
// A Stop hook sent while the host was down is lost; the transcript is not.
const STALE_STATE_MS = 2 * 60_000;
const NUDGE_TEXT =
	"End your final message with the SUPERSET_WORKER_DONE or SUPERSET_WORKER_BLOCKED envelope from your instructions, for this issue's key.";

export type PlanAgentState = {
	state: "starting" | "working" | "blocked" | "idle" | "gone";
	lastEventAt?: number;
};

export type PlanLaunchInput = {
	run: PlanRun;
	issue: PlanRunIssue;
	branch: string;
	baseBranch?: string;
	prompt: string;
	model?: string;
	effort?: string;
};

export interface PlanRunDeps {
	store: Pick<PlanRunStore, "list" | "save">;
	/** Creates the issue's workspace on the first attempt, then starts an agent in it. */
	launch(input: PlanLaunchInput): Promise<{
		workspaceId: string;
		terminalId: string;
	}>;
	agentState(issue: PlanRunIssue): Promise<PlanAgentState>;
	/** The agent's last answer, or null when its transcript cannot be read yet. */
	readAnswer(issue: PlanRunIssue): Promise<string | null>;
	nudge(issue: PlanRunIssue, text: string): Promise<void>;
	routingRules(): Promise<LaunchRules | null>;
	now?: () => number;
	setIntervalFn?: typeof setInterval;
}

export class PlanRunInputError extends Error {
	constructor(readonly errors: string[]) {
		super(errors.join("\n"));
	}
}

/**
 * Runs imported plans on this host: starts one workspace and agent per ready
 * issue under each run's cap, reads each agent's envelope when it stops,
 * retries a failure once a size up, and blocks the dependents of a failure.
 * Every change is saved before the next step, so a restart resumes the queue.
 */
export class PlanRunManager {
	private readonly runs = new Map<string, PlanRun>();
	private loaded: Promise<void> | null = null;
	private ticking: Promise<void> | null = null;
	private tickAgain = false;
	private ticker: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: PlanRunDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private load(): Promise<void> {
		this.loaded ??= this.deps.store.list().then((runs) => {
			for (const run of runs) this.runs.set(run.id, run);
		});
		return this.loaded;
	}

	private async save(run: PlanRun): Promise<void> {
		run.updatedAt = this.now();
		await this.deps.store.save(run);
	}

	async importRun(input: {
		projectId: string;
		name: string;
		maxParallel: number;
		issues: unknown;
	}): Promise<PlanRun> {
		await this.load();
		const { issues, errors } = checkPlanIssues(input.issues);
		if (errors.length > 0) throw new PlanRunInputError(errors);
		const now = this.now();
		const run: PlanRun = {
			id: randomUUID(),
			projectId: input.projectId,
			name: input.name,
			maxParallel: input.maxParallel,
			status: "idle",
			createdAt: now,
			updatedAt: now,
			issues: issues.map((issue) => ({
				...issue,
				status: "queued",
				attempts: 0,
			})),
		};
		await this.deps.store.save(run);
		this.runs.set(run.id, run);
		return run;
	}

	async list(): Promise<PlanRun[]> {
		await this.load();
		return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
	}

	async get(id: string): Promise<PlanRun | undefined> {
		await this.load();
		return this.runs.get(id);
	}

	async start(id: string, maxParallel?: number): Promise<PlanRun | undefined> {
		const run = await this.get(id);
		if (!run) return undefined;
		if (maxParallel !== undefined) run.maxParallel = maxParallel;
		if (run.status !== "done") run.status = "running";
		await this.save(run);
		void this.tick();
		return run;
	}

	async cancel(id: string): Promise<PlanRun | undefined> {
		const run = await this.get(id);
		if (!run) return undefined;
		if (run.status !== "done") run.status = "cancelled";
		await this.save(run);
		return run;
	}

	async setMaxParallel(
		id: string,
		maxParallel: number,
	): Promise<PlanRun | undefined> {
		const run = await this.get(id);
		if (!run) return undefined;
		run.maxParallel = maxParallel;
		await this.save(run);
		void this.tick();
		return run;
	}

	/** One pass over every running plan; overlapping calls fold into one more pass. */
	tick(): Promise<void> {
		if (this.ticking) {
			this.tickAgain = true;
			return this.ticking;
		}
		this.ticking = (async () => {
			do {
				this.tickAgain = false;
				await this.load();
				for (const run of this.runs.values()) {
					if (run.status !== "running") continue;
					try {
						await this.advance(run);
					} catch (error) {
						console.warn(`[plan-runs] run ${run.name} (${run.id}):`, error);
					}
				}
			} while (this.tickAgain);
		})().finally(() => {
			this.ticking = null;
		});
		return this.ticking;
	}

	startLoop(intervalMs: number): void {
		if (this.ticker) return;
		this.ticker = (this.deps.setIntervalFn ?? setInterval)(() => {
			void this.tick();
		}, intervalMs);
		this.ticker.unref?.();
		void this.tick();
	}

	stop(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = null;
	}

	private async advance(run: PlanRun): Promise<void> {
		const rules = await this.deps.routingRules().catch((error: unknown) => {
			console.warn("[plan-runs] routing.json ignored:", error);
			return null;
		});
		for (const issue of run.issues) {
			if (issue.status === "running") await this.reconcile(run, issue, rules);
		}
		const statusOf = (key: string) =>
			run.issues.find((issue) => issue.key === key)?.status ?? "queued";
		for (const key of readyIssueKeys(run.issues, statusOf)) {
			const running = run.issues.filter((i) => i.status === "running").length;
			if (running >= run.maxParallel) break;
			const issue = run.issues.find((i) => i.key === key);
			if (issue) await this.launch(run, issue, rules);
		}
		const open = run.issues.some(
			(issue) => issue.status === "queued" || issue.status === "running",
		);
		if (!open) {
			run.status = "done";
			await this.save(run);
			console.log(`[plan-runs] run ${run.name} finished`);
		}
	}

	private async reconcile(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
	): Promise<void> {
		const { state, lastEventAt } = await this.deps.agentState(issue);
		if (state === "gone") {
			return this.fail(run, issue, rules, "the agent's terminal ended");
		}
		const stale =
			lastEventAt !== undefined && this.now() - lastEventAt > STALE_STATE_MS;
		if (state !== "idle" && !stale) return;
		if (issue.nudgedAt !== undefined && (lastEventAt ?? 0) <= issue.nudgedAt) {
			return;
		}
		const answer = await this.deps.readAnswer(issue);
		if (answer === null) return;
		const envelope = parseWorkerEnvelope(answer, issue.key);
		if (state !== "idle" && !envelope) return;
		if (envelope?.kind === "done") {
			issue.status = "done";
			issue.summary = envelope.summary;
			issue.error = undefined;
			await this.save(run);
			console.log(`[plan-runs] ${run.name}/${issue.key} done`);
			return;
		}
		if (envelope?.kind === "blocked") {
			return this.fail(run, issue, rules, `blocked: ${envelope.reason}`);
		}
		if (issue.nudgedAt === undefined) {
			await this.deps.nudge(issue, NUDGE_TEXT);
			issue.nudgedAt = this.now();
			await this.save(run);
			return;
		}
		return this.fail(
			run,
			issue,
			rules,
			"the agent stopped without an envelope",
		);
	}

	private async fail(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
		reason: string,
	): Promise<void> {
		console.warn(`[plan-runs] ${run.name}/${issue.key}: ${reason}`);
		if (issue.attempts < MAX_ATTEMPTS) {
			return this.launch(run, issue, rules, reason);
		}
		issue.status = "failed";
		issue.error = reason;
		for (const key of dependentKeys(run.issues, issue.key)) {
			const dependent = run.issues.find((i) => i.key === key);
			if (dependent?.status === "queued") {
				dependent.status = "blocked";
				dependent.error = `dependency ${issue.key} failed`;
			}
		}
		await this.save(run);
	}

	private async launch(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
		previousFailure?: string,
	): Promise<void> {
		const attempt = issue.attempts + 1;
		const size = rules ? escalateSize(rules, issue.size, attempt) : issue.size;
		const choice = rules
			? estimateAgentLaunch(
					{ presetId: "claude", prompt: issue.prompt, size },
					rules,
				)
			: null;
		const parent = run.issues.find((i) => i.key === issue.stackOn);
		const branch = issue.branch ?? `ade/${run.name}/${issue.key}`;
		issue.attempts = attempt;
		try {
			const launched = await this.deps.launch({
				run,
				issue,
				branch,
				baseBranch: parent?.branch,
				prompt: workerPrompt(run, issue, previousFailure),
				model: choice?.model,
				effort: choice?.effort,
			});
			Object.assign(issue, launched, {
				branch,
				status: "running",
				launchedAt: this.now(),
				nudgedAt: undefined,
				error: previousFailure,
			});
			console.log(
				`[plan-runs] ${run.name}/${issue.key} attempt ${attempt} on ${choice?.model ?? "default model"} (size ${size})`,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			issue.status = "queued";
			issue.error = `launch failed: ${reason}`;
			await this.save(run);
			if (attempt >= MAX_ATTEMPTS) {
				return this.fail(run, issue, rules, issue.error);
			}
			return;
		}
		await this.save(run);
	}
}

/** The last `Assistant:` turn of a harness transcript (`readHarnessTranscript`). */
export function lastAssistantTurn(transcript: string): string | null {
	const index = transcript.lastIndexOf("\n\nAssistant: ");
	if (index !== -1) return transcript.slice(index + 2);
	return transcript.startsWith("Assistant: ") ? transcript : null;
}

export function workerPrompt(
	run: PlanRun,
	issue: PlanRunIssue,
	previousFailure?: string,
): string {
	const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
	return [
		`You work on issue ${issue.key} of plan ${run.name}: ${issue.title}.`,
		"",
		issue.prompt,
		"",
		`Files you may change: ${issue.files.join(", ") || "as the task requires"}. Do not change anything else and do not broaden the scope.`,
		"Acceptance:",
		list(issue.acceptance),
		"Before you finish, run each of these from the repository root and make them pass:",
		list(issue.verify),
		"Commit your work on the current branch with a conventional commit message. Do not push and do not open a pull request.",
		...(previousFailure
			? [
					"",
					`A previous attempt failed: ${previousFailure}. Start from the current state of the branch.`,
				]
			: []),
		"",
		`End your final message with exactly one of these envelopes, with task set to ${issue.key}:`,
		"SUPERSET_WORKER_DONE",
		"task: <this issue's key>",
		"summary: <one-line outcome>",
		"files: <comma-separated paths>",
		"checks: <commands and outcomes>",
		"handoff: none",
		"",
		"SUPERSET_WORKER_BLOCKED",
		"task: <this issue's key>",
		"reason: <specific blocker>",
		"needs: <decision, access, or dependency required>",
	].join("\n");
}
