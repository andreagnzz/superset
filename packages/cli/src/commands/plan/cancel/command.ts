import { boolean, positional, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { onPlanHost, planRunsOn } from "../plan-runs-client";

export default command({
	description:
		"Stop starting new issues of a plan run; agents already running keep going",
	args: [positional("id").required().desc("Plan run ID")],
	options: {
		host: string().desc("Target host machineId (required unless --local)"),
		local: boolean().desc("Target this machine (required unless --host)"),
	},
	run: async ({ ctx, args, options }) => {
		const planRuns = await planRunsOn(ctx, options);
		const run = await onPlanHost(() =>
			planRuns.cancel.mutate({ id: args.id as string }),
		);
		return { data: run, message: `Plan run ${run.name} is ${run.status}` };
	},
});
