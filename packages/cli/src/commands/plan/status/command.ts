import { boolean, positional, string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { onPlanHost, planRunsOn } from "../plan-runs-client";

export default command({
	description:
		"Show a plan run's issues: status, attempts, review round, pull request, branch",
	args: [positional("id").required().desc("Plan run ID")],
	options: {
		host: string().desc("Target host machineId (required unless --local)"),
		local: boolean().desc("Target this machine (required unless --host)"),
	},
	display: (data) =>
		table(
			((data as { issues?: Record<string, unknown>[] } | undefined)?.issues ??
				[]) as Record<string, unknown>[],
			[
				"key",
				"status",
				"attempts",
				"reviewRound",
				"prNumber",
				"branch",
				"error",
			],
			["KEY", "STATUS", "ATTEMPTS", "REVIEW", "PR", "BRANCH", "ERROR"],
		),
	run: async ({ ctx, args, options }) => {
		const planRuns = await planRunsOn(ctx, options);
		const run = await onPlanHost(() =>
			planRuns.get.query({ id: args.id as string }),
		);
		return { data: run, message: `${run.name}: ${run.status}` };
	},
});
