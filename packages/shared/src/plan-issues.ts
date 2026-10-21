/**
 * The issue list `/ade:plan` writes (`plans/<ts>-<name>.issues.json`) and the
 * host's plan runs execute: one entry per pull request, with dependencies.
 */

export const PLAN_ISSUE_SIZES = ["S", "M", "L"] as const;
export type PlanIssueSize = (typeof PLAN_ISSUE_SIZES)[number];

export type PlanIssueSpec = {
	key: string;
	title: string;
	prompt: string;
	size: PlanIssueSize;
	dependsOn: string[];
	stackOn: string | null;
	files: string[];
	acceptance: string[];
	verify: string[];
};

export type WorkerEnvelope =
	| { kind: "done"; summary: string }
	| { kind: "blocked"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isFilled(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isSize(value: unknown): value is PlanIssueSize {
	return PLAN_ISSUE_SIZES.some((size) => size === value);
}

function parseIssue(
	item: unknown,
	at: string,
	errors: string[],
): PlanIssueSpec | null {
	if (!isRecord(item)) {
		errors.push(`${at}: must be an object`);
		return null;
	}
	const { key, title, prompt, size, dependsOn, stackOn, files } = item;
	const { acceptance, verify } = item;
	const keyOk = typeof key === "string" && /^[A-Za-z0-9_-]+$/.test(key);
	const titleOk = isFilled(title);
	const promptOk = isFilled(prompt);
	const sizeOk = isSize(size);
	const dependsOnOk = isStrings(dependsOn);
	const stackOnOk = stackOn === null || typeof stackOn === "string";
	const filesOk = isStrings(files);
	const acceptanceOk = isStrings(acceptance) && acceptance.length > 0;
	const verifyOk = isStrings(verify) && verify.some(isFilled);

	if (!keyOk) errors.push(`${at}: key must match [A-Za-z0-9_-]+`);
	if (!titleOk) errors.push(`${at}: title is required`);
	if (!promptOk) errors.push(`${at}: prompt is required`);
	if (size === "XL") errors.push(`${at}: size XL is too big, split it`);
	else if (!sizeOk) errors.push(`${at}: size must be S, M or L`);
	if (!dependsOnOk) errors.push(`${at}: dependsOn must list keys`);
	if (!stackOnOk) errors.push(`${at}: stackOn must be a key or null`);
	if (!filesOk) errors.push(`${at}: files must list paths`);
	if (!acceptanceOk) errors.push(`${at}: acceptance needs a criterion`);
	if (!verifyOk) errors.push(`${at}: verify needs at least one command`);

	if (
		!keyOk ||
		!titleOk ||
		!promptOk ||
		!sizeOk ||
		!dependsOnOk ||
		!stackOnOk ||
		!filesOk ||
		!acceptanceOk ||
		!verifyOk
	) {
		return null;
	}
	return {
		key,
		title,
		prompt,
		size,
		dependsOn,
		stackOn,
		files,
		acceptance,
		verify: verify.filter(isFilled),
	};
}

/** Validates an issues.json value; `order` is a topological order of the keys. */
export function checkPlanIssues(raw: unknown): {
	issues: PlanIssueSpec[];
	order: string[];
	errors: string[];
} {
	const errors: string[] = [];
	if (!Array.isArray(raw) || raw.length === 0) {
		return { issues: [], order: [], errors: ["must be a non-empty array"] };
	}
	const issues: PlanIssueSpec[] = [];
	raw.forEach((item, index) => {
		const at =
			isRecord(item) && typeof item.key === "string"
				? `issue ${item.key}`
				: `issue #${index}`;
		const issue = parseIssue(item, at, errors);
		if (issue) issues.push(issue);
	});

	const keys = new Set<string>();
	for (const { key } of issues) {
		if (keys.has(key)) errors.push(`issue ${key}: duplicate key`);
		keys.add(key);
	}
	for (const { key, dependsOn, stackOn } of issues) {
		for (const dep of dependsOn) {
			if (dep === key) errors.push(`issue ${key}: depends on itself`);
			else if (!keys.has(dep)) {
				errors.push(`issue ${key}: unknown dependency ${dep}`);
			}
		}
		if (stackOn !== null && !dependsOn.includes(stackOn)) {
			errors.push(`issue ${key}: stackOn ${stackOn} must also be in dependsOn`);
		}
	}

	const order: string[] = [];
	const pending = new Map(issues.map((i) => [i.key, new Set(i.dependsOn)]));
	while (pending.size > 0) {
		const next = [...pending].find(([, deps]) =>
			[...deps].every((dep) => !pending.has(dep) || !keys.has(dep)),
		);
		if (!next) {
			errors.push(`dependency cycle among: ${[...pending.keys()].join(", ")}`);
			break;
		}
		order.push(next[0]);
		pending.delete(next[0]);
	}
	return { issues, order, errors };
}

/** Keys still queued whose dependencies are all done, in list order. */
export function readyIssueKeys(
	issues: PlanIssueSpec[],
	statusOf: (key: string) => string,
): string[] {
	return issues
		.filter((issue) => statusOf(issue.key) === "queued")
		.filter((issue) => issue.dependsOn.every((dep) => statusOf(dep) === "done"))
		.map((issue) => issue.key);
}

/** Every key that depends on `key`, directly or through other issues. */
export function dependentKeys(issues: PlanIssueSpec[], key: string): string[] {
	const found = new Set<string>();
	const visit = (parent: string) => {
		for (const issue of issues) {
			if (issue.dependsOn.includes(parent) && !found.has(issue.key)) {
				found.add(issue.key);
				visit(issue.key);
			}
		}
	};
	visit(key);
	return [...found];
}

/**
 * The last `SUPERSET_WORKER_DONE` / `SUPERSET_WORKER_BLOCKED` envelope for
 * `key` in an agent's output (the orchestration protocol of
 * `plugins/superset/skills/orchestrate`), or null when there is none.
 */
export function parseWorkerEnvelope(
	text: string,
	key: string,
): WorkerEnvelope | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	for (let start = lines.length - 1; start >= 0; start--) {
		const marker = /SUPERSET_WORKER_(DONE|BLOCKED)\s*$/.exec(
			lines[start] ?? "",
		);
		if (!marker) continue;
		const fields = new Map<string, string>();
		for (const line of lines.slice(start + 1, start + 8)) {
			const field = /^([a-z]+):\s*(.*)$/.exec(line);
			if (field?.[1] && field[2] !== undefined) {
				fields.set(field[1], field[2]);
			}
		}
		if (fields.get("task") !== key) continue;
		return marker[1] === "DONE"
			? { kind: "done", summary: fields.get("summary") ?? "" }
			: { kind: "blocked", reason: fields.get("reason") ?? "" };
	}
	return null;
}
