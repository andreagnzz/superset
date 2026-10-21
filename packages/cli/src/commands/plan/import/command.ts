import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	boolean,
	CLIError,
	number,
	positional,
	string,
} from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { onPlanHost, planRunsOn } from "../plan-runs-client";

export default command({
	description:
		"Import an issues.json written by /ade:plan as a plan run (not started)",
	args: [positional("file").required().desc("Path to <ts>-<name>.issues.json")],
	options: {
		project: string().required().desc("Project ID on the host"),
		name: string().desc("Run name (default: from the file name)"),
		maxParallel: number().desc("Agents working at once (default 3)"),
		host: string().desc("Target host machineId (required unless --local)"),
		local: boolean().desc("Target this machine (required unless --host)"),
	},
	run: async ({ ctx, args, options }) => {
		const file = args.file as string;
		let issues: unknown;
		try {
			issues = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new CLIError(
				`Cannot read ${file}`,
				error instanceof Error ? error.message : String(error),
			);
		}
		const name =
			options.name ??
			basename(file, ".issues.json")
				.replace(/^\d{8}-\d{4}-/, "")
				.toLowerCase();
		const planRuns = await planRunsOn(ctx, options);
		const run = await onPlanHost(() =>
			planRuns.import.mutate({
				projectId: options.project,
				name,
				maxParallel: options.maxParallel ?? undefined,
				issues: Array.isArray(issues) ? issues : [],
			}),
		);
		return {
			data: run,
			message: `Imported plan run ${run.id} (${run.name}, ${run.issues.length} issues). Start it with: superset plan run ${run.id}`,
		};
	},
});
