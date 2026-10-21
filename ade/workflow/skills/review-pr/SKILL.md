---
name: review-pr
description: Review one pull request with a fresh reviewer agent in its Superset workspace, send the findings back to the implementer, and loop until approved or three rounds. Used by /ade:run-plan; also callable on its own.
argument-hint: <workspace-id> <pr-number> [implementer-terminal-id]
---

# Review a pull request with fresh reviewers

Arguments: workspace `$0`, pull request `$1`, implementer terminal `$2` (optional; without it, findings are reported but not sent back).

Each round starts a new reviewer agent with no shared context (no `--resume-session`, `--fork-session` or `--from-terminal`). A reviewer never edits code; it only writes `.superset-review/verdict.json`. Never run `superset update`: this host runs a fork.

## Setup

```bash
ADE=${CLAUDE_PLUGIN_ROOT}/scripts/ade.ts
W=$0; PR=$1; IMPL=$2
WT=$(superset workspaces get "$W" --local --json | jq -r .worktreePath)
EXCLUDE="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
grep -qxF '.superset-review/' "$EXCLUDE" || echo '.superset-review/' >> "$EXCLUDE"
ROLE=$(bun "$ADE" role review)   # {"model":…,"effort":…}
```

## Each round, r = 1, 2, 3

1. `rm -f "$WT/.superset-review/verdict.json"; mkdir -p "$WT/.superset-review"`.
2. Write the reviewer prompt exactly as below (the shell fills in `$PR`; do not edit the text by hand):

```bash
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<EOF
You are a code reviewer with no prior context on this work. Review pull request #$PR of this repository: run \`gh pr view $PR\` and \`gh pr diff $PR\`, then read the changed files and their callers as needed. Check correctness and edge cases, security, and that tests cover the change; run the verify commands listed in the PR body.
Do not create, modify or delete any file except \`.superset-review/verdict.json\`. Do not commit, push, comment on GitHub, or run any command that changes git state.
Write \`.superset-review/verdict.json\` as:
{"approve": <true|false>, "findings": [{"file": "<path>", "line": <number or null>, "severity": "blocker|major|minor", "fix": "<what to change and why>"}]}
\`approve\` is true only when no finding is blocker or major. Then reply REVIEW_WRITTEN.
EOF
```

3. Start the reviewer and keep its terminal id:

   ```bash
   R=$(superset agents create --local --workspace "$W" --agent claude \
     --model "$(jq -r .model <<<"$ROLE")" --effort "$(jq -r .effort <<<"$ROLE")" \
     --prompt="$(cat "$PROMPT_FILE")" --json | jq -r .sessionId)
   superset agents wait --local --workspace "$W" --terminal "$R" --until settled --timeout 900 --json
   ```

   On a timeout, wait again (twice at most). If the state is `blocked`, read the screen (`superset terminals read … --max-lines 80 --json`) and answer only a permission prompt.
4. Check the verdict: `bun "$ADE" verdict "$WT/.superset-review/verdict.json"`. If it fails, send the error to the reviewer once (`superset terminals send --local --workspace "$W" --terminal "$R" --text="<error, fix the verdict file>" --wait --until settled --timeout 600`) and check again. Still invalid: this round is "changes requested" with the single finding `reviewer produced no valid verdict`.
5. Close the reviewer: `superset terminals close --local --workspace "$W" --terminal "$R"`.
6. Comment on the PR, from the repository: `gh pr comment "$PR" --body-file <file>` with:

   ```text
   ADE review, round <r>: approved | changes requested
   - [<severity>] <file>:<line> <fix>
   ```

7. Approved: stop and go to Result.
8. Not approved and `r < 3` and `$IMPL` is set: note `BEFORE=$(git -C "$WT" rev-parse HEAD)`, then send the findings to the implementer and wait for its turn:

   ```bash
   superset terminals send --local --workspace "$W" --terminal "$IMPL" --text="$(cat "$FINDINGS_FILE")" \
     --wait --until settled --timeout 1200 --json
   ```

   where the findings file holds the findings list followed by: `Fix these review findings. Run the verify commands. Commit on the current branch; do not push. End with the SUPERSET_WORKER_DONE or SUPERSET_WORKER_BLOCKED envelope.` Then, if `git -C "$WT" rev-parse HEAD` differs from `$BEFORE`, push: `git -C "$WT" push`. If nothing was committed, say so in the next PR comment.
9. Not approved and `r = 3`: stop; the PR is blocked.

## Result

End with exactly one line:

```text
REVIEW_RESULT pr=<PR> approved=<true|false> rounds=<r>
```
