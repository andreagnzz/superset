import { CLIError } from "@superset/cli-framework";
import type { CliContext } from "../../lib/command";
import { requireHostTarget, resolveHostTarget } from "../../lib/host-target";

export async function planRunsOn(
	ctx: CliContext,
	flags: { host: string | undefined; local: boolean | undefined },
) {
	const organizationId = ctx.config.organizationId;
	if (!organizationId) {
		throw new CLIError("No active organization", "Run: superset auth login");
	}
	const target = await resolveHostTarget({
		requestedHostId: requireHostTarget(flags),
		organizationId,
		userJwt: ctx.bearer,
		api: ctx.api,
	});
	return target.client.planRuns;
}

/** A host built before plan runs answers "no procedure found". */
export async function onPlanHost<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/no procedure found|procedure .* not found on server/i.test(message)) {
			throw new CLIError(
				"This host does not run plans",
				"Install a host built from the fork with plan runs (roadmap M2/M3)",
			);
		}
		throw error;
	}
}
