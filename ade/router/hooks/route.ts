export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export type Tier = { model: string; effort: Effort };
export type Routing = {
	tiers: Record<string, Tier>;
	roles: Record<string, Tier>;
	subagents: Record<string, string>;
	rules: { match: RegExp; tier: string }[];
};
export type Route = Tier & { reason: string };

const RULES_OR_PARENT = "rules-or-parent";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEffort(value: unknown): value is Effort {
	return EFFORTS.some((effort) => effort === value);
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseTiers(value: unknown, where: string): Record<string, Tier> {
	if (!isRecord(value)) throw new Error(`${where} must be an object`);
	const tiers: Record<string, Tier> = {};
	for (const [name, tier] of Object.entries(value)) {
		if (!isRecord(tier) || typeof tier.model !== "string" || !tier.model) {
			throw new Error(`${where}.${name}.model must be a non-empty string`);
		}
		if (!isEffort(tier.effort)) {
			throw new Error(`${where}.${name}.effort must be one of ${EFFORTS}`);
		}
		tiers[name] = { model: tier.model, effort: tier.effort };
	}
	return tiers;
}

export function parseRouting(text: string): Routing {
	const raw: unknown = JSON.parse(text);
	if (!isRecord(raw)) throw new Error("routing.json must be an object");
	const tiers = parseTiers(raw.tiers, "tiers");
	const roles = parseTiers(raw.roles, "roles");

	if (!isRecord(raw.subagents)) throw new Error("subagents must be an object");
	const subagents: Record<string, string> = {};
	for (const [type, target] of Object.entries(raw.subagents)) {
		if (typeof target !== "string") {
			throw new Error(`subagents.${type} must be a string`);
		}
		if (target !== RULES_OR_PARENT && !own(roles, target)) {
			throw new Error(`subagents.${type} names an unknown role: ${target}`);
		}
		subagents[type] = target;
	}

	if (!Array.isArray(raw.rules)) throw new Error("rules must be an array");
	const rules = raw.rules.map((rule: unknown, index) => {
		if (!isRecord(rule) || typeof rule.match !== "string") {
			throw new Error(`rules[${index}].match must be a string`);
		}
		if (typeof rule.tier !== "string" || !own(tiers, rule.tier)) {
			throw new Error(`rules[${index}].tier must name a tier`);
		}
		return { match: new RegExp(rule.match, "i"), tier: rule.tier };
	});

	return { tiers, roles, subagents, rules };
}

/**
 * The subagent's type picks a role; otherwise the first rule matching its
 * prompt picks a tier; otherwise null leaves the caller's or parent's choice.
 */
export function routeSubagent(
	routing: Routing,
	{ subagentType, prompt }: { subagentType: string; prompt: string },
): Route | null {
	const target =
		own(routing.subagents, subagentType) ??
		own(routing.subagents, "*") ??
		RULES_OR_PARENT;
	if (target !== RULES_OR_PARENT) {
		const role = own(routing.roles, target);
		return role ? { ...role, reason: `role ${target}` } : null;
	}
	const rule = routing.rules.find(({ match }) => match.test(prompt));
	const tier = rule && own(routing.tiers, rule.tier);
	return rule && tier ? { ...tier, reason: `tier ${rule.tier}` } : null;
}
