import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRestackTask, gitStackStateTask } from "./plan-stack";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const IDENTITY = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...IDENTITY },
	}).trim();
}

function commit(cwd: string, file: string, text: string) {
	writeFileSync(join(cwd, file), text);
	git(cwd, "add", file);
	git(cwd, "commit", "-qm", `edit ${file}`);
}

/** main ← parent ← child, all pushed to a bare origin; returns the clone. */
function stack() {
	const root = mkdtempSync(join(tmpdir(), "plan-stack-"));
	dirs.push(root);
	const origin = join(root, "origin.git");
	const clone = join(root, "clone");
	git(root, "init", "-q", "--bare", "-b", "main", origin);
	git(root, "clone", "-q", origin, clone);
	commit(clone, "base.txt", "base\n");
	git(clone, "push", "-q", "origin", "main");
	git(clone, "remote", "set-head", "origin", "main");
	git(clone, "switch", "-qc", "parent");
	commit(clone, "parent.txt", "parent\n");
	git(clone, "push", "-q", "-u", "origin", "parent");
	const parentSha = git(clone, "rev-parse", "HEAD");
	git(clone, "switch", "-qc", "child");
	commit(clone, "child.txt", "child\n");
	git(clone, "push", "-q", "-u", "origin", "child");
	return { clone, parentSha };
}

/** Moves origin/parent forward from a second checkout of the branch. */
function advanceParent(clone: string, file: string, text: string) {
	const other = `${clone}-parent`;
	git(clone, "worktree", "add", "-q", other, "parent");
	commit(other, file, text);
	git(other, "push", "-q", "origin", "parent");
	return git(other, "rev-parse", "HEAD");
}

describe("plan stack tasks", () => {
	it("rebases a child onto its advanced parent and pushes it", async () => {
		const { clone, parentSha } = stack();
		const state = await gitStackStateTask.handler({
			worktreePath: clone,
			base: "parent",
			gitEnv: IDENTITY,
		});
		expect(state.mergeBase).toBe(parentSha);

		const newParent = advanceParent(clone, "parent2.txt", "more\n");
		const result = await gitRestackTask.handler({
			worktreePath: clone,
			onto: "parent",
			upstream: parentSha,
			gitEnv: IDENTITY,
		});
		expect(result.ok && result.baseSha).toBe(newParent);
		expect(git(clone, "rev-parse", "HEAD~1")).toBe(newParent);
		expect(git(clone, "rev-parse", "origin/child")).toBe(
			git(clone, "rev-parse", "HEAD"),
		);
	});

	it("aborts on a conflict and leaves the branch as it was", async () => {
		const { clone, parentSha } = stack();
		advanceParent(clone, "child.txt", "conflicting\n");
		const before = git(clone, "rev-parse", "HEAD");
		const result = await gitRestackTask.handler({
			worktreePath: clone,
			onto: "parent",
			upstream: parentSha,
			gitEnv: IDENTITY,
		});
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("rebase-failed");
		expect(git(clone, "rev-parse", "HEAD")).toBe(before);
		expect(git(clone, "status", "--porcelain")).toBe("");
	});
});
