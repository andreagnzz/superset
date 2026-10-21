import { randomUUID } from "node:crypto";
import {
	escalateSize,
	estimateAgentLaunch,
	type LaunchRules,
} from "@superset/shared/agent-launch-estimator";
import {
	checkPlanIssues,
	checkReviewVerdict,
	dependentKeys,
	parseWorkerEnvelope,
	type ReviewVerdict,
	readyIssueKeys,
} from "@superset/shared/plan-issues";
import type { PlanRun, PlanRunIssue, PlanRunStore } from "./store";

const MAX_ATTEMPTS = 2;
const MAX_REVIEW_ROUNDS = 3;
// Stacks are checked against GitHub and the remote at most once a minute per run.
const STACK_CHECK_MS = 60_000;
// A Stop hook sent while the host was down is lost; the transcript is not.
const STALE_STATE_MS = 2 * 60_000;
const NUDGE_TEXT =
	"End your final message with the SUPERSET_WORKER_DONE or SUPERSET_WORKER_BLOCKED envelope from your instructions, for this issue's key.";

export type PlanAgentState = {
	state: "starting" | "working" | "blocked" | "idle" | "gone";
	lastEventAt?: number;
	/** The agent's last hook event was a Stop: its turn is over. Idle alone is not. */
	turnEnded?: boolean;
};

/** One agent terminal of an issue: its implementer or its current reviewer. */
export type PlanAgentTarget = { workspaceId?: string; terminalId?: string };

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
	/** Starts a fresh reviewer in the issue's workspace. */
	launchReviewer(input: {
		run: PlanRun;
		issue: PlanRunIssue;
		prompt: string;
		verdictFile: string;
		model?: string;
		effort?: string;
	}): Promise<{ terminalId: string }>;
	agentState(target: PlanAgentTarget): Promise<PlanAgentState>;
	/** The agent's last answer, or null when its transcript cannot be read yet. */
	readAnswer(target: PlanAgentTarget): Promise<string | null>;
	send(target: PlanAgentTarget, text: string): Promise<void>;
	closeTerminal(target: PlanAgentTarget): Promise<void>;
	/** Pushes the issue's branch, and opens its pull request the first time. */
	publish(input: {
		run: PlanRun;
		issue: PlanRunIssue;
		title: string;
		body: string;
	}): Promise<{ prNumber: number; prUrl: string }>;
	comment(run: PlanRun, issue: PlanRunIssue, body: string): Promise<void>;
	verdictPath(run: PlanRun, issue: PlanRunIssue, round: number): string;
	/** The verdict file's JSON, its raw text when it is not JSON, or null when absent. */
	readVerdict(path: string): Promise<unknown>;
	/** The issue's branch against its git base (the default branch when unset), fetched. */
	stackState(issue: PlanRunIssue): Promise<{
		base: string;
		baseHead: string | null;
		mergeBase: string | null;
	}>;
	/** Replays the issue's commits after `upstream` onto `onto` and force-pushes with a lease. */
	restack(
		issue: PlanRunIssue,
		onto: string | undefined,
		upstream: string,
	): Promise<
		| { ok: true; base: string; baseSha: string }
		| { ok: false; reason: string; detail: string }
	>;
	pullRequestState(
		run: PlanRun,
		issue: PlanRunIssue,
	): Promise<"open" | "merged" | "closed">;
	/** Points the issue's pull request at `base` (the default branch when unset). */
	retarget(
		run: PlanRun,
		issue: PlanRunIssue,
		base: string | undefined,
	): Promise<void>;
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
 * issue under each run's cap, publishes each finished issue as a pull request,
 * loops fresh reviewers on it until approval or three rounds, retries a failed
 * implementation once a size up, and blocks the dependents of a failure.
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
					if (run.status !== "running" && run.status !== "done") continue;
					try {
						if (run.status === "running") await this.advance(run);
						await this.maintainStacks(run);
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
			if (issue.status === "running")
				await this.reconcileWorker(run, issue, rules);
			else if (issue.status === "review") {
				await this.reconcileReview(run, issue, rules);
			}
		}
		const statusOf = (key: string) =>
			run.issues.find((issue) => issue.key === key)?.status ?? "queued";
		for (const key of readyIssueKeys(run.issues, statusOf)) {
			if (activeCount(run) >= run.maxParallel) break;
			const issue = run.issues.find((i) => i.key === key);
			if (issue) await this.launch(run, issue, rules);
		}
		const open = run.issues.some((issue) =>
			["queued", "running", "review"].includes(issue.status),
		);
		if (!open) {
			run.status = "done";
			await this.save(run);
			console.log(`[plan-runs] run ${run.name} finished`);
		}
	}

	/**
	 * The agent's answer once its turn is over: idle, or idle-looking after a
	 * missed Stop. Answers older than the last message sent to it do not count.
	 */
	private async settledAnswer(
		target: PlanAgentTarget,
		askedAt: number | undefined,
	): Promise<
		| { gone: true }
		| { gone: false; ended: boolean; answer: string | null }
		| null
	> {
		const { state, lastEventAt, turnEnded } =
			await this.deps.agentState(target);
		if (state === "gone") return { gone: true };
		const stale =
			lastEventAt !== undefined && this.now() - lastEventAt > STALE_STATE_MS;
		if (!turnEnded && !stale) return null;
		if (askedAt !== undefined && (lastEventAt ?? 0) <= askedAt) return null;
		const answer = await this.deps.readAnswer(target);
		return { gone: false, ended: turnEnded === true, answer };
	}

	private async reconcileWorker(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
	): Promise<void> {
		const settled = await this.settledAnswer(issue, issue.askedAt);
		if (!settled) return;
		if (settled.gone) {
			return this.fail(run, issue, rules, "the agent's terminal ended");
		}
		if (settled.answer === null) return;
		const envelope = parseWorkerEnvelope(settled.answer, issue.key);
		if (!settled.ended && !envelope) return;
		if (envelope?.kind === "done") {
			issue.summary = envelope.summary;
			issue.error = undefined;
			return this.publishAndReview(run, issue, rules);
		}
		if (envelope?.kind === "blocked") {
			return this.fail(run, issue, rules, `blocked: ${envelope.reason}`);
		}
		if (!issue.nudged) {
			await this.deps.send(issue, NUDGE_TEXT);
			issue.nudged = true;
			issue.askedAt = this.now();
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

	private async publishAndReview(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
	): Promise<void> {
		try {
			const pr = await this.deps.publish({
				run,
				issue,
				title: issue.title,
				body: pullRequestBody(run, issue),
			});
			issue.prNumber = pr.prNumber;
			issue.prUrl = pr.prUrl;
			// Where the branch left its base, for a later restack.
			issue.baseSha ??=
				(await this.deps.stackState(issue)).mergeBase ?? undefined;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return this.endIssue(run, issue, "failed", `publish failed: ${reason}`);
		}
		return this.startReview(run, issue, rules, (issue.reviewRound ?? 0) + 1);
	}

	private async startReview(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
		round: number,
	): Promise<void> {
		const role = rules
			? estimateAgentLaunch(
					{ presetId: "claude", prompt: "", role: "review" },
					rules,
				)
			: null;
		const verdictFile = this.deps.verdictPath(run, issue, round);
		try {
			const { terminalId } = await this.deps.launchReviewer({
				run,
				issue,
				prompt: reviewerPrompt(issue.prNumber ?? 0, verdictFile),
				verdictFile,
				model: role?.model,
				effort: role?.effort,
			});
			Object.assign(issue, {
				status: "review",
				reviewRound: round,
				reviewerTerminalId: terminalId,
				reviewerNudged: false,
			});
			console.log(`[plan-runs] ${run.name}/${issue.key} review round ${round}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return this.endIssue(
				run,
				issue,
				"failed",
				`reviewer launch failed: ${reason}`,
			);
		}
		await this.save(run);
	}

	private async reconcileReview(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
	): Promise<void> {
		const reviewer = {
			workspaceId: issue.workspaceId,
			terminalId: issue.reviewerTerminalId,
		};
		const settled = await this.settledAnswer(reviewer, undefined);
		if (!settled) return;
		const round = issue.reviewRound ?? 1;
		const raw = await this.deps.readVerdict(
			this.deps.verdictPath(run, issue, round),
		);
		const { verdict, errors } = checkReviewVerdict(raw);
		if (!verdict && !settled.gone && !issue.reviewerNudged) {
			await this.deps.send(
				reviewer,
				`The verdict file is ${raw === null ? "missing" : `invalid: ${errors.join("; ")}`}. Write it as your instructions say.`,
			);
			issue.reviewerNudged = true;
			await this.save(run);
			return;
		}
		await this.deps.closeTerminal(reviewer).catch((error: unknown) => {
			console.warn("[plan-runs] closing the reviewer failed:", error);
		});
		issue.reviewerTerminalId = undefined;
		await this.deps
			.comment(
				run,
				issue,
				verdict
					? reviewComment(round, verdict)
					: `ADE review, round ${round}: the reviewer wrote no valid verdict`,
			)
			.catch((error: unknown) => {
				console.warn("[plan-runs] posting the review failed:", error);
			});
		const result = verdict;
		if (!result) {
			// Nothing for the implementer to fix: a new reviewer takes the next round.
			if (round >= MAX_REVIEW_ROUNDS) {
				return this.endIssue(run, issue, "blocked", "no valid review verdict");
			}
			return this.startReview(run, issue, rules, round + 1);
		}
		if (result.approve) {
			issue.status = "done";
			issue.error = undefined;
			await this.save(run);
			console.log(
				`[plan-runs] ${run.name}/${issue.key} approved at round ${round}`,
			);
			return;
		}
		if (round >= MAX_REVIEW_ROUNDS) {
			return this.endIssue(
				run,
				issue,
				"blocked",
				`review not approved after ${round} rounds`,
			);
		}
		await this.deps.send(issue, findingsMessage(issue, round, result));
		Object.assign(issue, {
			status: "running",
			askedAt: this.now(),
			nudged: false,
		});
		await this.save(run);
	}

	/**
	 * Keeps stacked pull requests on their base once their issues are done:
	 * rebases a child whose parent branch moved, and retargets and rebases a
	 * child whose parent was merged. Parents are handled before children, so a
	 * change cascades down a stack in one pass.
	 */
	private async maintainStacks(run: PlanRun): Promise<void> {
		if (this.now() - (run.lastStackCheckAt ?? 0) < STACK_CHECK_MS) return;
		run.lastStackCheckAt = this.now();
		const ordered = [...run.issues].sort(
			(a, b) => stackDepth(run, a) - stackDepth(run, b),
		);
		for (const issue of ordered) {
			if (!issue.prNumber || issue.stackError) continue;
			if (issue.prState === "merged" || issue.prState === "closed") continue;
			try {
				issue.prState = await this.deps.pullRequestState(run, issue);
				await this.restackIssue(run, issue);
			} catch (error) {
				console.warn(
					`[plan-runs] ${run.name}/${issue.key} stack check:`,
					error,
				);
			}
		}
		await this.save(run);
	}

	private async restackIssue(run: PlanRun, issue: PlanRunIssue): Promise<void> {
		if (issue.prState !== "open" || issue.status !== "done") return;
		if (!issue.baseBranch || !issue.baseSha) return;
		const parent = run.issues.find((i) => i.branch === issue.baseBranch);
		const parentMerged = parent?.prState === "merged";
		if (!parentMerged) {
			const { baseHead } = await this.deps.stackState(issue);
			if (!baseHead || baseHead === issue.baseSha) return;
		}
		const onto = parentMerged ? parent?.baseBranch : issue.baseBranch;
		const result = await this.deps.restack(issue, onto, issue.baseSha);
		if (!result.ok) {
			issue.stackError = `restack onto ${onto ?? "the default branch"} failed (${result.reason}): ${result.detail.slice(0, 300)}`;
			await this.deps
				.comment(
					run,
					issue,
					`ADE stack: ${issue.stackError}. Rebase it by hand.`,
				)
				.catch((error: unknown) => {
					console.warn("[plan-runs] posting the stack error failed:", error);
				});
			return;
		}
		if (parentMerged) await this.deps.retarget(run, issue, onto);
		issue.baseBranch = onto;
		issue.baseSha = result.baseSha;
		const note = parentMerged
			? `#${parent?.prNumber} was merged; retargeted onto ${result.base} and rebased.`
			: `rebased onto ${result.base} (${result.baseSha.slice(0, 7)}) after it changed.`;
		await this.deps
			.comment(run, issue, `ADE stack: ${note}`)
			.catch((error: unknown) => {
				console.warn("[plan-runs] posting the stack note failed:", error);
			});
		console.log(`[plan-runs] ${run.name}/${issue.key} ${note}`);
	}

	private async fail(
		run: PlanRun,
		issue: PlanRunIssue,
		rules: LaunchRules | null,
		reason: string,
	): Promise<void> {
		console.warn(`[plan-runs] ${run.name}/${issue.key}: ${reason}`);
		// A failure while fixing review findings has no clean state to retry from.
		if (issue.attempts < MAX_ATTEMPTS && !issue.reviewRound) {
			return this.launch(run, issue, rules, reason);
		}
		return this.endIssue(
			run,
			issue,
			issue.reviewRound ? "blocked" : "failed",
			reason,
		);
	}

	/** Ends an issue for good and blocks every issue that waits on it. */
	private async endIssue(
		run: PlanRun,
		issue: PlanRunIssue,
		status: "failed" | "blocked",
		reason: string,
	): Promise<void> {
		issue.status = status;
		issue.error = reason;
		for (const key of dependentKeys(run.issues, issue.key)) {
			const dependent = run.issues.find((i) => i.key === key);
			if (dependent?.status === "queued") {
				dependent.status = "blocked";
				dependent.error = `dependency ${issue.key} ${status}`;
			}
		}
		await this.save(run);
		console.warn(`[plan-runs] ${run.name}/${issue.key} ${status}: ${reason}`);
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
				baseBranch: parent?.branch,
				status: "running",
				launchedAt: this.now(),
				askedAt: undefined,
				nudged: false,
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

function stackDepth(run: PlanRun, issue: PlanRunIssue): number {
	const parent = run.issues.find((i) => i.key === issue.stackOn);
	return parent ? 1 + stackDepth(run, parent) : 0;
}

/** Issues holding an agent that works or is about to: implementers and reviewers. */
function activeCount(run: PlanRun): number {
	return run.issues.filter(
		(issue) => issue.status === "running" || issue.status === "review",
	).length;
}

/** The last `Assistant:` turn of a harness transcript (`readHarnessTranscript`). */
export function lastAssistantTurn(transcript: string): string | null {
	const index = transcript.lastIndexOf("\n\nAssistant: ");
	if (index !== -1) return transcript.slice(index + 2);
	return transcript.startsWith("Assistant: ") ? transcript : null;
}

const bullets = (items: string[]) =>
	items.map((item) => `- ${item}`).join("\n");

export function workerPrompt(
	run: PlanRun,
	issue: PlanRunIssue,
	previousFailure?: string,
): string {
	return [
		`You work on issue ${issue.key} of plan ${run.name}: ${issue.title}.`,
		"",
		issue.prompt,
		"",
		`Files you may change: ${issue.files.join(", ") || "as the task requires"}. Do not change anything else and do not broaden the scope.`,
		"Acceptance:",
		bullets(issue.acceptance),
		"Before you finish, run each of these from the repository root and make them pass:",
		bullets(issue.verify),
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

function pullRequestBody(run: PlanRun, issue: PlanRunIssue): string {
	const parent = run.issues.find((i) => i.key === issue.stackOn);
	return [
		issue.summary || issue.title,
		"",
		"Verify:",
		bullets(issue.verify),
		"",
		`Plan ${run.name}, issue ${issue.key}.`,
		...(parent?.prNumber ? [`Stacked on #${parent.prNumber}.`] : []),
	].join("\n");
}

export function reviewerPrompt(prNumber: number, verdictFile: string): string {
	return [
		`You are a code reviewer with no prior context on this work. Review pull request #${prNumber} of this repository: run \`gh pr view ${prNumber}\` and \`gh pr diff ${prNumber}\`, then read the changed files and their callers as needed. Check correctness and edge cases, security, and that tests cover the change; run the verify commands listed in the pull request body.`,
		`Do not create, modify or delete any file except ${verdictFile}. Do not commit, push, comment on GitHub, or run any command that changes git state.`,
		`Write ${verdictFile} as:`,
		'{"approve": <true|false>, "findings": [{"file": "<path>", "line": <number or null>, "severity": "blocker|major|minor", "fix": "<what to change and why>"}]}',
		"`approve` is true only when no finding is blocker or major. Then reply REVIEW_WRITTEN.",
	].join("\n");
}

function findingLines(verdict: ReviewVerdict): string[] {
	return verdict.findings.map(
		(f) =>
			`[${f.severity}] ${f.file}${f.line === null ? "" : `:${f.line}`} ${f.fix}`,
	);
}

function reviewComment(round: number, verdict: ReviewVerdict): string {
	return [
		`ADE review, round ${round}: ${verdict.approve ? "approved" : "changes requested"}`,
		bullets(findingLines(verdict)),
	]
		.filter(Boolean)
		.join("\n");
}

function findingsMessage(
	issue: PlanRunIssue,
	round: number,
	verdict: ReviewVerdict,
): string {
	return [
		`Review round ${round} of pull request #${issue.prNumber} requested changes:`,
		bullets(findingLines(verdict)),
		`Fix these findings on the current branch, run ${issue.verify.join(", ")}, and commit. Do not push.`,
		`End your final message with the SUPERSET_WORKER_DONE envelope for issue ${issue.key}, or SUPERSET_WORKER_BLOCKED if you cannot fix them.`,
	].join("\n");
}
