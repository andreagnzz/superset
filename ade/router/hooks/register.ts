import type { Register } from "claude-code";
import { parseRouting, type Routing, routeSubagent } from "./route";

type RoutingSource = {
	plugin: { root: string };
	fs: { read: (path: string) => Promise<string> };
};

// Read on every spawn so an edit applies to the next subagent. A missing or
// invalid file throws, and the engine skips the hook: the subagent keeps the
// caller's choice.
async function readRouting($: RoutingSource): Promise<Routing> {
	return parseRouting(await $.fs.read(`${$.plugin.root}/routing.json`));
}

export const register: Register = (on) => {
	on("agent.spawn", async ($, e, next) => {
		if (e.fork || e.resume) return next(e);
		const route = routeSubagent(await readRouting($), {
			subagentType: e.subagentType,
			prompt: e.prompt,
		});
		return next(route ? { ...e, model: route.model } : e);
	});

	on("tool.call", { tool: "Agent" }, async ($, e, next) => {
		const subagentType = e.subagent_type ?? "general-purpose";
		if (subagentType === "fork") return next(e);
		const route = routeSubagent(await readRouting($), {
			subagentType,
			prompt: e.prompt,
		});
		return next(route ? { ...e, effort: route.effort } : e);
	});
};
