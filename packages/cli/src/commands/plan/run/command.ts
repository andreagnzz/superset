import { boolean, number, positional, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { onPlanHost, planRunsOn } from "../plan-runs-client";

export default command({
	description:
		"Start (or resume) a plan run; the host keeps running it after you disconnect",
	args: [positional("id").required().desc("Plan run ID")],
	options: {
		maxParallel: number().desc("Agents working at once"),
		host: string().desc("Target host machineId (required unless --local)"),
		local: boolean().desc("Target this machine (required unless --host)"),
	},
	run: async ({ ctx, args, options }) => {
		const planRuns = await planRunsOn(ctx, options);
		const run = await onPlanHost(() =>
			planRuns.start.mutate({
				id: args.id as string,
				maxParallel: options.maxParallel ?? undefined,
			}),
		);
		return {
			data: run,
			message: `Plan run ${run.name} is ${run.status} (max ${run.maxParallel} agents)`,
		};
	},
});
