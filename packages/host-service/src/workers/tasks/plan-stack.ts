import { createUserSimpleGit } from "../../runtime/git/simple-git.ts";
import { defineWorkerTask } from "../define-worker-task.ts";
import type { GitTaskEnv } from "./git.ts";

async function resolveBase(
	git: ReturnType<typeof createUserSimpleGit>,
	base: string | undefined,
): Promise<string> {
	if (base) return base;
	const ref = await git.raw([
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	return ref.trim().replace(/^origin\//, "");
}

/**
 * Where a stacked branch stands against its base (the repository's default
 * branch when `base` is absent), after fetching the base.
 */
export const gitStackStateTask = defineWorkerTask<
	{ worktreePath: string; base?: string; gitEnv: GitTaskEnv },
	{ base: string; baseHead: string | null; mergeBase: string | null }
>({
	type: "plan-stack/state",
	handler: async ({ worktreePath, base, gitEnv }) => {
		const git = createUserSimpleGit(worktreePath, { env: gitEnv });
		const name = await resolveBase(git, base);
		// A base deleted on the remote (merged and cleaned up) has no head.
		const fetched = await git.raw(["fetch", "origin", name]).then(
			() => true,
			() => false,
		);
		if (!fetched) return { base: name, baseHead: null, mergeBase: null };
		const baseHead = (
			await git.raw(["rev-parse", `refs/remotes/origin/${name}`])
		).trim();
		const mergeBase = (await git.raw(["merge-base", "HEAD", baseHead])).trim();
		return { base: name, baseHead, mergeBase };
	},
});

/**
 * Replays the branch's own commits (those after `upstream`) onto the fetched
 * base and force-pushes with a lease, so a push someone else made in between
 * is never overwritten. A failed rebase (a conflict) is aborted and changes nothing.
 */
export const gitRestackTask = defineWorkerTask<
	{ worktreePath: string; onto?: string; upstream: string; gitEnv: GitTaskEnv },
	| { ok: true; base: string; baseSha: string; headSha: string }
	| {
			ok: false;
			reason: "rebase-failed" | "detached-head" | "dirty";
			detail: string;
	  }
>({
	type: "plan-stack/restack",
	handler: async ({ worktreePath, onto, upstream, gitEnv }) => {
		const git = createUserSimpleGit(worktreePath, { env: gitEnv });
		const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
		if (!branch || branch === "HEAD") {
			return { ok: false, reason: "detached-head", detail: "" };
		}
		if ((await git.raw(["status", "--porcelain"])).trim()) {
			return { ok: false, reason: "dirty", detail: "uncommitted changes" };
		}
		const base = await resolveBase(git, onto);
		await git.raw(["fetch", "origin", base]);
		const baseSha = (
			await git.raw(["rev-parse", `refs/remotes/origin/${base}`])
		).trim();
		try {
			await git.raw(["rebase", "--onto", baseSha, upstream, branch]);
		} catch (error) {
			await git.raw(["rebase", "--abort"]).catch(() => undefined);
			return {
				ok: false,
				reason: "rebase-failed",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		await git.raw(["push", "--force-with-lease", "origin", branch]);
		const headSha = (await git.revparse(["HEAD"])).trim();
		return { ok: true, base, baseSha, headSha };
	},
});

export const planStackTasks = [gitStackStateTask, gitRestackTask];
