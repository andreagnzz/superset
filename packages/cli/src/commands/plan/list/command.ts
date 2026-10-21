import { boolean, string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { onPlanHost, planRunsOn } from "../plan-runs-client";

export default command({
	description: "List the plan runs on a host",
	options: {
		host: string().desc("Target host machineId (required unless --local)"),
		local: boolean().desc("Target this machine (required unless --host)"),
	},
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["name", "status", "maxParallel", "id"],
			["NAME", "STATUS", "MAX", "ID"],
		),
	run: async ({ ctx, options }) => {
		const planRuns = await planRunsOn(ctx, options);
		return await onPlanHost(() => planRuns.list.query());
	},
});
