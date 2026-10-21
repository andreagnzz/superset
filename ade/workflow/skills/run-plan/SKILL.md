---
name: run-plan
description: Run an issues.json written by /ade:plan. One Superset workspace and Claude agent per issue, dependencies respected, at most N agents working at once, stacked branches, one PR per issue, each reviewed by /ade:review-pr.
argument-hint: <plans/...issues.json> [--max-parallel N]
disable-model-invocation: true
---

# Run a plan

Arguments: `$ARGUMENTS`. The issues file is the first argument; `N` is the number after `--max-parallel` (default 3).

You are the coordinator. You never edit code yourself. The run's state lives in your context: keep the table below current and print it after every change. This follows Superset's orchestration protocol (worker envelopes, completion only after checking evidence), with one exception: never run `superset update` or `superset start --auto-update`, because this host runs a fork.

## 0. Preflight: stop and report on the first failure

```bash
ADE=${CLAUDE_PLUGIN_ROOT}/scripts/ade.ts
FILE=<issues file>
bun "$ADE" check "$FILE"                      # must print OK …
REPO=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
BASE=$(git -C "$REPO" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')
PROJECT=$(superset projects list --local --json | jq -r --arg r "$REPO" '.[] | select(.repoPath == $r) | .id')
(cd "$REPO" && gh repo set-default --view)    # must print owner/repo: without it a fork clone opens PRs upstream
jq -r --arg p "$REPO" '.projects[$p].hasTrustDialogAccepted // false' ~/.claude.json   # must print true
RUN=$(basename "$FILE" .issues.json | sed 's/^[0-9]*-[0-9]*-//')
```

- `PROJECT` empty: this repository is not a Superset project on this host; stop.
- Trust is `false`: every workspace would stop on Claude's "do you trust this folder" dialog. Stop and tell the user to open `claude` once in `$REPO` and accept.
- Workspace names are `$RUN-<key>`, branches `ade/$RUN/<key>`, the workspace tag is `$RUN`.

## 1. Table

| key | dependsOn | stackOn | status | attempt | workspace | terminal | branch | PR | base |

`status` is one of: `pending`, `running`, `review`, `done`, `failed`, `blocked`. Every issue starts `pending`, attempt 0.

## 2. Loop

Repeat until no issue is `pending`, `running` or `review`:

1. Free slots: `FREE = N - $(superset snapshot --json | bun "$ADE" active "$RUN-")`. Count before every start of an implementer or a reviewer: a reviewer is an agent too.
2. Ready issues: `bun "$ADE" ready "$FILE" --done <done keys> --active <running and review keys> --failed <failed and blocked keys>` (comma-separated). Mark `blocked` every pending issue that depends, directly or not, on a `failed` or `blocked` one.
3. Start ready issues in file order while `FREE > 0` (section 3).
4. Wait on each `running` issue in turn: `superset agents wait --local --workspace <W> --terminal <T> --until settled --timeout 300 --json`. A timeout is normal: go to the next one. When one settles, handle it (section 4).
5. Run the review of a `review` issue (section 5) only when `FREE > 0`.

## 3. Start an issue

1. `attempt += 1`. `TIER=$(bun "$ADE" tier "$FILE" <key> <attempt>)` gives `model` and `effort` (one size up after a failure).
2. Base: with `stackOn = P`, push the parent first (`git -C "$REPO" push -u origin ade/$RUN/P`) and use `ade/$RUN/P`; otherwise `$BASE`.
3. First attempt only:
   `superset workspaces create --local --project "$PROJECT" --name "$RUN-<key>" --branch "ade/$RUN/<key>" --base-branch <base> --tag "$RUN" --json`; keep `.workspace.id`.
4. Write the worker prompt to a temporary file and start the agent:
   `superset agents create --local --workspace <W> --agent claude --model <model> --effort <effort> --prompt "$(cat <file>)" --json`; keep `.sessionId` as the terminal.

Worker prompt (fill every field from the issue; on a second attempt add `A previous attempt failed: <reason>. Start from the current branch state.`):

```text
You work on issue <key> of plan <RUN>: <title>.

<prompt>

Files you may change: <files>. Do not change anything else and do not broaden the scope.
Acceptance:
- <acceptance, one per line>
Before you finish, run each of these from the repository root and make them pass:
- <verify, one per line>
Commit your work on the current branch with a conventional commit message. Do not push and do not open a pull request.

End your final message with exactly one of these envelopes:
SUPERSET_WORKER_DONE
task: <key>
summary: <one-line outcome>
files: <comma-separated paths>
checks: <commands and outcomes>
handoff: none

SUPERSET_WORKER_BLOCKED
task: <key>
reason: <specific blocker>
needs: <decision, access, or dependency required>
```

## 4. A worker settled

1. Read: `superset terminals read --local --workspace <W> --terminal <T> --max-lines 200 --json | jq -r .text` and find the last envelope for this key.
2. No envelope and the agent is idle: send once `End your message with the SUPERSET_WORKER_DONE or SUPERSET_WORKER_BLOCKED envelope.` with `superset terminals send … --wait --until settled --timeout 600`, then read again.
3. `SUPERSET_WORKER_DONE`: check the evidence yourself in the worktree (`WT=$(superset workspaces get <W> --local --json | jq -r .worktreePath)`): `git -C "$WT" status --porcelain` is empty, `git -C "$WT" log --oneline <base>..HEAD` shows at least one commit, and every verify command passes when run from `$WT`. Then:
   - `git -C "$WT" push -u origin ade/$RUN/<key>`
   - from `$REPO`: `gh pr create --head ade/$RUN/<key> --base <base> --title "<title>" --body-file <file>` with the summary, the verify commands and their results, and for a stacked issue `Stacked on #<parent PR>`. Record the PR number.
   - status `review`.
4. `SUPERSET_WORKER_BLOCKED`, or a failed check: on attempt 1, start the issue again (section 3, same workspace) with the reason. On attempt 2, status `failed`.

## 5. Review

Run `/ade:review-pr <W> <PR> <T>` (or follow `${CLAUDE_PLUGIN_ROOT}/skills/review-pr/SKILL.md` with those arguments). Its last line is `REVIEW_RESULT pr=<PR> approved=<bool> rounds=<r>`: approved gives `done`; not approved gives `blocked`.

## 6. Finish

Print the final table and the PR list with each PR's base: a stacked PR targets its parent's branch, so merge from the bottom of the stack up, and retarget the next PR to `$BASE` after each merge. Tell the user with `superset notifications show "Plan run finished" --body "<n done, m blocked, k failed>"` (ignore a failure of this command). Leave the workspaces and terminals open for inspection.
