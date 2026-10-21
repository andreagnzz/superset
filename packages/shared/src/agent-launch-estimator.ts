/**
 * Picks a model and effort for an agent launch that names neither, from a
 * routing.json (the format of `ade/router/routing.json`): an explicit role,
 * then a size, then the first rule matching the prompt, then the fallback tier.
 */

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
type Choice = { model: string; effort: Effort };

export type LaunchRules = {
	tiers: Record<string, Choice>;
	roles: Record<string, Choice>;
	rules: { match: RegExp; tier: string }[];
	fallbackTier: string | null;
};

export type LaunchEstimate = Choice & { reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseChoices(value: unknown, where: string): Record<string, Choice> {
	if (!isRecord(value)) throw new Error(`${where} must be an object`);
	const choices: Record<string, Choice> = {};
	for (const [name, choice] of Object.entries(value)) {
		const effort = isRecord(choice) ? choice.effort : undefined;
		if (
			!isRecord(choice) ||
			typeof choice.model !== "string" ||
			!choice.model
		) {
			throw new Error(`${where}.${name}.model must be a non-empty string`);
		}
		const level = EFFORTS.find((candidate) => candidate === effort);
		if (!level) {
			throw new Error(`${where}.${name}.effort must be one of ${EFFORTS}`);
		}
		choices[name] = { model: choice.model, effort: level };
	}
	return choices;
}

export function parseLaunchRules(text: string): LaunchRules {
	const raw: unknown = JSON.parse(text);
	if (!isRecord(raw)) throw new Error("routing.json must be an object");
	const tiers = parseChoices(raw.tiers, "tiers");
	const roles = raw.roles === undefined ? {} : parseChoices(raw.roles, "roles");
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
	const fallbackTier =
		typeof raw.fallbackTier === "string" ? raw.fallbackTier : null;
	if (fallbackTier !== null && !own(tiers, fallbackTier)) {
		throw new Error(`fallbackTier ${fallbackTier} is not a tier`);
	}
	return { tiers, roles, rules, fallbackTier };
}

/** Null for presets other than Claude, whose model aliases the rules use. */
export function estimateAgentLaunch(
	{
		presetId,
		prompt,
		size,
		role,
	}: { presetId: string; prompt: string; size?: string; role?: string },
	rules: LaunchRules,
): LaunchEstimate | null {
	if (presetId !== "claude") return null;
	const byRole = role ? own(rules.roles, role) : undefined;
	if (byRole) return { ...byRole, reason: `role ${role}` };
	const bySize = size ? own(rules.tiers, size) : undefined;
	if (bySize) return { ...bySize, reason: `size ${size}` };
	const rule = rules.rules.find(({ match }) => match.test(prompt));
	const tier = rule?.tier ?? rules.fallbackTier;
	const chosen = tier ? own(rules.tiers, tier) : undefined;
	if (!tier || !chosen) return null;
	const reason = rule
		? `rule /${rule.match.source}/ -> ${tier}`
		: `fallback ${tier}`;
	return { ...chosen, reason };
}
