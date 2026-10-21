import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRouting, type Tier } from "../../router/hooks/route";

export const SIZES = ["S", "M", "L"] as const;
export type Size = (typeof SIZES)[number];
export type Issue = {
	key: string;
	title: string;
	prompt: string;
	size: Size;
	dependsOn: string[];
	stackOn: string | null;
	files: string[];
	acceptance: string[];
	verify: string[];
};
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Finding = {
	file: string;
	line: number | null;
	severity: (typeof SEVERITIES)[number];
	fix: string;
};
export type Verdict = { approve: boolean; findings: Finding[] };

const DEFAULT_ROUTING = join(homedir(), ".local/share/ade/router/routing.json");
const ACTIVE_STATES = new Set(["starting", "working"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isFilled(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isSize(value: unknown): value is Size {
	return SIZES.some((size) => size === value);
}

function isSeverity(value: unknown): value is Finding["severity"] {
	return SEVERITIES.some((severity) => severity === value);
}

function parseIssue(item: unknown, at: string, errors: string[]): Issue | null {
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
export function checkIssues(raw: unknown): {
	issues: Issue[];
	order: string[];
	errors: string[];
} {
	const errors: string[] = [];
	if (!Array.isArray(raw) || raw.length === 0) {
		return { issues: [], order: [], errors: ["must be a non-empty array"] };
	}
	const issues: Issue[] = [];
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
			else if (!keys.has(dep))
				errors.push(`issue ${key}: unknown dependency ${dep}`);
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

/** Keys not yet started whose dependencies are all done, in file order. */
export function readyKeys(
	issues: Issue[],
	{
		done,
		active,
		failed,
	}: { done: string[]; active: string[]; failed: string[] },
): string[] {
	const started = new Set([...done, ...active, ...failed]);
	return issues
		.filter((i) => !started.has(i.key))
		.filter((i) => i.dependsOn.every((dep) => done.includes(dep)))
		.map((i) => i.key);
}

/** The issue's size as a tier, one tier up per failed attempt, capped. */
export function tierFor(
	routingText: string,
	size: Size,
	attempt: number,
): Tier & { tier: string } {
	const routing = parseRouting(routingText);
	const raw: unknown = JSON.parse(routingText);
	const escalation =
		isRecord(raw) && isRecord(raw.escalation) ? raw.escalation : {};
	const order = Object.keys(routing.tiers);
	const start = order.indexOf(size);
	if (start === -1) throw new Error(`routing.json has no tier ${size}`);
	const maxTier = order.indexOf(String(escalation.maxTier));
	const cap = maxTier === -1 ? order.length - 1 : maxTier;
	const every =
		typeof escalation.afterFailures === "number" && escalation.afterFailures > 0
			? escalation.afterFailures
			: 1;
	const index = Math.min(start + Math.floor((attempt - 1) / every), cap);
	const tier = order[index] ?? size;
	const chosen = routing.tiers[tier];
	if (!chosen) throw new Error(`routing.json has no tier ${tier}`);
	return { tier, ...chosen };
}

export function roleFor(routingText: string, name: string): Tier {
	const role = parseRouting(routingText).roles[name];
	if (!role) throw new Error(`routing.json has no role ${name}`);
	return role;
}

export function checkVerdict(raw: unknown): {
	verdict: Verdict | null;
	errors: string[];
} {
	const errors: string[] = [];
	if (!isRecord(raw)) return { verdict: null, errors: ["must be an object"] };
	if (typeof raw.approve !== "boolean")
		errors.push("approve must be a boolean");
	if (!Array.isArray(raw.findings)) errors.push("findings must be an array");
	const findings: Finding[] = [];
	for (const [index, item] of (Array.isArray(raw.findings)
		? raw.findings
		: []
	).entries()) {
		const at = `findings[${index}]`;
		if (!isRecord(item) || !isFilled(item.file) || !isFilled(item.fix)) {
			errors.push(`${at}: needs file and fix`);
			continue;
		}
		if (!isSeverity(item.severity)) {
			errors.push(`${at}: severity must be ${SEVERITIES.join(", ")}`);
			continue;
		}
		const line = typeof item.line === "number" ? item.line : null;
		findings.push({
			file: item.file,
			line,
			severity: item.severity,
			fix: item.fix,
		});
	}
	const blocking = findings.some((f) => f.severity !== "minor");
	if (raw.approve === true && blocking) {
		errors.push("approve must be false while a finding is blocker or major");
	}
	if (errors.length > 0 || typeof raw.approve !== "boolean") {
		return { verdict: null, errors };
	}
	return { verdict: { approve: raw.approve, findings }, errors };
}

/** Agents starting or working in workspaces whose name starts with `prefix`. */
export function countActive(snapshot: unknown, prefix: string): number {
	if (!isRecord(snapshot) || !Array.isArray(snapshot.workspaces)) {
		throw new Error("not a `superset snapshot --json` output");
	}
	let count = 0;
	for (const workspace of snapshot.workspaces) {
		if (!isRecord(workspace) || typeof workspace.name !== "string") continue;
		if (!workspace.name.startsWith(prefix)) continue;
		if (!Array.isArray(workspace.terminals)) continue;
		for (const terminal of workspace.terminals) {
			if (!isRecord(terminal) || !isRecord(terminal.agent)) continue;
			if (ACTIVE_STATES.has(String(terminal.agent.state))) count++;
		}
	}
	return count;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function list(args: string[], name: string): string[] {
	return (option(args, name) ?? "").split(",").filter(Boolean);
}

function loadIssues(path: string | undefined): Issue[] {
	if (!path) throw new Error("missing <issues.json>");
	const { issues, errors } = checkIssues(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return issues;
}

function main(argv: string[]): string {
	const [command, ...args] = argv;
	const routing = () =>
		readFileSync(option(args, "--routing") ?? DEFAULT_ROUTING, "utf8");
	switch (command) {
		case "check": {
			if (!args[0]) throw new Error("missing <issues.json>");
			const raw: unknown = JSON.parse(readFileSync(args[0], "utf8"));
			const { issues, order, errors } = checkIssues(raw);
			if (errors.length > 0) throw new Error(errors.join("\n"));
			return `OK ${issues.length} issues, order: ${order.join(", ")}`;
		}
		case "ready": {
			const issues = loadIssues(args[0]);
			const status = {
				done: list(args, "--done"),
				active: list(args, "--active"),
				failed: list(args, "--failed"),
			};
			return JSON.stringify(readyKeys(issues, status));
		}
		case "tier": {
			const issue = loadIssues(args[0]).find((i) => i.key === args[1]);
			if (!issue) throw new Error(`no issue ${args[1]}`);
			const attempt = Number(args[2] ?? "1");
			return JSON.stringify(tierFor(routing(), issue.size, attempt));
		}
		case "role":
			return JSON.stringify(roleFor(routing(), args[0] ?? ""));
		case "verdict": {
			if (!args[0]) throw new Error("missing <verdict.json>");
			const raw: unknown = JSON.parse(readFileSync(args[0], "utf8"));
			const { verdict, errors } = checkVerdict(raw);
			if (!verdict) throw new Error(errors.join("\n"));
			return JSON.stringify(verdict);
		}
		case "active": {
			const raw: unknown = JSON.parse(readFileSync(0, "utf8"));
			return String(countActive(raw, args[0] ?? ""));
		}
		default:
			throw new Error(
				"usage: ade.ts check|ready|tier|role|verdict|active (see the skills in ade/workflow)",
			);
	}
}

if (import.meta.main) {
	try {
		console.log(main(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
