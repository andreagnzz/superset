import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanIssueSpec } from "@superset/shared/plan-issues";

export type PlanIssueStatus =
	| "queued"
	| "running"
	| "review"
	| "done"
	| "failed"
	| "blocked";

export type PlanRunIssue = PlanIssueSpec & {
	status: PlanIssueStatus;
	attempts: number;
	workspaceId?: string;
	terminalId?: string;
	branch?: string;
	launchedAt?: number;
	/** When the implementer was last sent a message; its earlier answers do not count. */
	askedAt?: number;
	/** The implementer was already asked for a missing envelope. */
	nudged?: boolean;
	summary?: string;
	prNumber?: number;
	prUrl?: string;
	/** Review rounds started so far (fresh reviewer each round). */
	reviewRound?: number;
	reviewerTerminalId?: string;
	reviewerNudged?: boolean;
	error?: string;
};

export type PlanRunStatus = "idle" | "running" | "cancelled" | "done";

export type PlanRun = {
	id: string;
	projectId: string;
	name: string;
	maxParallel: number;
	status: PlanRunStatus;
	createdAt: number;
	updatedAt: number;
	issues: PlanRunIssue[];
};

/**
 * One JSON file per run in `dir`. A save writes a temporary file next to the
 * run's and renames it over, so a crash never leaves half a run.
 */
export class PlanRunStore {
	constructor(private readonly dir: string) {}

	async list(): Promise<PlanRun[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const runs: PlanRun[] = [];
		for (const name of names.filter((n) => n.endsWith(".json"))) {
			try {
				const run: unknown = JSON.parse(
					await readFile(join(this.dir, name), "utf8"),
				);
				if (isPlanRun(run)) runs.push(run);
				else console.warn(`[plan-runs] skipped ${name}: not a plan run`);
			} catch (error) {
				console.warn(`[plan-runs] skipped ${name}:`, error);
			}
		}
		return runs;
	}

	async save(run: PlanRun): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const file = join(this.dir, `${run.id}.json`);
		const tmp = `${file}.${randomUUID()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`);
		await rename(tmp, file);
	}
}

function isPlanRun(value: unknown): value is PlanRun {
	if (typeof value !== "object" || value === null) return false;
	const run = value as Record<string, unknown>;
	return (
		typeof run.id === "string" &&
		typeof run.projectId === "string" &&
		typeof run.name === "string" &&
		typeof run.maxParallel === "number" &&
		typeof run.status === "string" &&
		Array.isArray(run.issues)
	);
}
