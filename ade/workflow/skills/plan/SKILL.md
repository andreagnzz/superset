---
name: plan
description: Plan a feature as an ExecPlan plus a list of PR-sized issues (dependencies, size, verify commands) that /ade:run-plan can execute. Writes only under plans/.
argument-hint: <feature description>
model: opus
effort: xhigh
disable-model-invocation: true
---

# Plan a feature into issues

You are the planner. The feature to plan: $ARGUMENTS

## Rules

- Explore the repository read-only first. Read `AGENTS.md` and `CLAUDE.md` at the root if they exist, and follow their conventions in the plan.
- Write files only under `plans/` at the repository root. Do not edit code, do not commit, do not create branches or workspaces, do not start agents.
- Every term the plan uses must be explained in it: the issues are executed by fresh agents that only see their own issue prompt.

## Outputs

Take one timestamp with `date +%Y%m%d-%H%M` and a short kebab-case name, then write two files with the same prefix:

1. `plans/<timestamp>-<name>.md`: an ExecPlan. If the repository has `.agents/commands/create-plan.md`, follow it; otherwise follow [execplan-format.md](execplan-format.md).
2. `plans/<timestamp>-<name>.issues.json`: a JSON array of issues, each:

```json
{
  "key": "A",
  "title": "Add slugify to src/strings.js",
  "prompt": "Self-contained task for an agent that knows nothing else: goal, where the code goes, constraints, what not to touch.",
  "size": "S",
  "dependsOn": [],
  "stackOn": null,
  "files": ["src/strings.js", "test/strings.test.js"],
  "acceptance": ["slugify('Hello World') returns 'hello-world'"],
  "verify": ["npm test"]
}
```

## How to split

- One issue is one pull request that can be reviewed and verified on its own.
- `size`: `S` (one file, a few dozen lines), `M` (a few files in one area), `L` (several files or a subtle change). `XL` is not allowed: split it. An issue that touches independent areas is split too.
- `dependsOn` lists the keys that must be finished first. `stackOn` names one of them when the issue needs that issue's code: its branch then starts from the parent's branch and its PR targets it. Otherwise `stackOn` is `null` and the issue starts from the default branch, in parallel with the others. Prefer independent issues and short chains.
- `verify` holds shell commands run from the repository root that exit 0 when the issue is done (tests, typecheck, lint). At least one.
- `prompt` repeats everything the agent needs from the plan: it will not read the plan.

## Check

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/ade.ts check plans/<timestamp>-<name>.issues.json
```

It prints `OK <n> issues, order: …` or one error per line. Fix the file and run it again until it prints `OK`.

## Finish

Reply with the two paths, a table of the issues (key, size, dependsOn, stackOn, title), and the commands to run them. On a host that runs this fork, the host keeps the run going after every terminal closes, opens one pull request per issue and loops fresh reviewers on it:

```text
superset plan import plans/<timestamp>-<name>.issues.json --project <project id> --local
superset plan run <run id> --max-parallel 3 --local
```

Otherwise, from this session (the run lives in the session's context):

```text
/ade:run-plan plans/<timestamp>-<name>.issues.json --max-parallel 3
```
