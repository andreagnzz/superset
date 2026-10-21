import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { type PlanRun, PlanRunInputError } from "../../../runtime/plan-runs";
import { protectedProcedure, router } from "../../index";
import { requireLocalProject } from "../workspace-creation/shared/local-project";

const runId = z.object({ id: z.string().min(1) });
const maxParallel = z.number().int().min(1).max(10);

function found(run: PlanRun | undefined, id: string): PlanRun {
	if (!run) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `No plan run ${id} on this host`,
		});
	}
	return run;
}

/** Plans imported from an `/ade:plan` issues.json and run by this host. */
export const planRunsRouter = router({
	import: protectedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				name: z
					.string()
					.regex(
						/^[a-z0-9][a-z0-9-]*$/,
						"lowercase letters, digits and dashes",
					),
				maxParallel: maxParallel.default(3),
				issues: z.array(z.unknown()),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			requireLocalProject(ctx, input.projectId);
			try {
				return await ctx.runtime.planRuns.importRun(input);
			} catch (error) {
				if (error instanceof PlanRunInputError) {
					throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
				}
				throw error;
			}
		}),

	list: protectedProcedure.query(({ ctx }) => ctx.runtime.planRuns.list()),

	get: protectedProcedure
		.input(runId)
		.query(async ({ ctx, input }) =>
			found(await ctx.runtime.planRuns.get(input.id), input.id),
		),

	start: protectedProcedure
		.input(runId.extend({ maxParallel: maxParallel.optional() }))
		.mutation(async ({ ctx, input }) =>
			found(
				await ctx.runtime.planRuns.start(input.id, input.maxParallel),
				input.id,
			),
		),

	cancel: protectedProcedure
		.input(runId)
		.mutation(async ({ ctx, input }) =>
			found(await ctx.runtime.planRuns.cancel(input.id), input.id),
		),

	setMaxParallel: protectedProcedure
		.input(runId.extend({ maxParallel }))
		.mutation(async ({ ctx, input }) =>
			found(
				await ctx.runtime.planRuns.setMaxParallel(input.id, input.maxParallel),
				input.id,
			),
		),
});
