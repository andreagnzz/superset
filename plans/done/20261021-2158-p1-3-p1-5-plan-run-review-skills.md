# Plan a feature into issues, run them in parallel workspaces, and review each PR with a fresh agent

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

Reference: This plan follows conventions from `AGENTS.md` and `.agents/commands/create-plan.md`. It covers milestones P1.3, P1.4 and P1.5 of the roadmap `plans/20261021-1400-ade-perso-roadmap.md` (written in French), and the roadmap's "Acceptance Phase 1".


## Purpose / Big Picture

After this plan, the owner can, on the VPS `claude-vps`, open Claude Code in a repository that is a Superset project and type three commands. `/ade:plan <feature>` makes an Opus session at `xhigh` effort write an ExecPlan and an `issues.json` (one entry per pull request, with dependencies, a size S/M/L, and verify commands) under `plans/`, and checks the graph. `/ade:run-plan plans/<…>.issues.json --max-parallel 2` starts one Superset workspace and one Claude agent per issue as soon as its dependencies are done, never with more than two agents working at once, picks each agent's model and effort from the issue size (one size up after a failure), stacks a branch on its parent when the issue says so, and opens one pull request per issue with the right base. Each pull request then goes through `/ade:review-pr`: a fresh Claude reviewer (no shared context) writes a verdict; on "changes requested" the findings go back to the implementer, and a new fresh reviewer looks again, up to three rounds.

To see it working: run the acceptance in Validation on the toy repository `andreagnzz/ade-sandbox`.


## Assumptions

The VPS runs this fork's host (`~/superset`, version 1.39.0) and Claude Code 2.1.305, with the `router` mod of P1.2 loaded through `CLAUDE_CODE_PLUGIN_DIRS`. The toy repository `andreagnzz/ade-sandbox` is cloned at `~/code/ade-sandbox`, is the Superset project `ade-sandbox` (id `437aeaae-b674-4b77-ab34-d4ae154f3015`), is trusted in `~/.claude.json`, has `origin/HEAD` on `main`, and `gh repo set-default` points at it. The owner authorized going ahead without a plan-approval stop.


## Open Questions

None.


## Progress

- [x] (2026-10-21 20:00Z) Toy repository created (private), pushed, attached to the session; Superset project points at it.
- [x] (2026-10-21 20:00Z) Plan written.
- [x] (2026-10-21 20:10Z) Milestone 1: `ade/workflow/scripts/ade.ts` (check, ready, tier, role, verdict, active); `bun test ade/workflow` 8 pass; strict typecheck clean.
- [x] (2026-10-21 20:20Z) Milestone 2: the three skills, `claude plugin validate` passes, deployed to `~/.local/share/ade/workflow`, `CLAUDE_CODE_PLUGIN_DIRS` lists both plugins.
- [x] (2026-10-21 20:05Z) Milestone 3: `/ade:plan` run headless on the toy repo wrote `plans/20261021-2203-string-helpers.{md,issues.json}`; `check` prints `OK 4 issues`.
- [x] (2026-10-21 20:16Z) Milestone 4: Phase 1 acceptance run passed (4 issues, 2 stacked, `--max-parallel 2`; first attempt stopped at preflight on a wrong JSON field, fixed and re-run).
- [x] (2026-10-21 20:30Z) Review loop checked on a PR with a planted bug (changes requested, fixed, approved at round 2).
- [x] (2026-10-21 20:35Z) Milestone 5: roadmap updated, plan moved to `plans/done/`, PR merged.


## Surprises & Discoveries

- Observation: a stacked issue has exactly one parent (`stackOn`), and nothing is merged into the default branch during a run, so an issue that needs the code of two issues forces the planner to chain them. Asked for a helper built on two others, `/ade:plan` chained all four issues (A ← B ← C ← D) and explained why; such a plan runs with no parallelism. A later milestone (roadmap M3/M4) could start a child from a merge of several parent branches.
  Evidence: `plans/20261021-2203-string-helpers.md` and `.issues.json` in `andreagnzz/ade-sandbox` (`OK 4 issues, order: A, B, C, D`).

- Observation: `superset projects list --json` names the main checkout `path`, while `superset projects create --json` returns it as `repoPath`; the first acceptance attempt stopped at preflight because the skill read `repoPath`. The preflight stopped as designed instead of guessing.
  Evidence: `PROJECT=` empty in the first coordinator run; `projects list` output `{ "name", "repo", "path", "id" }`.

- Observation: the coordinator filled the reviewer prompt's `<PR>` placeholder with a `sed` that dropped the number from the first sentence (the `gh` commands kept it, so the reviews were still right). The skill now builds the prompt with a heredoc and `$PR`, so nothing is filled by hand.
  Evidence: the coordinator's own note at the end of the run.

- Observation: `superset terminals send --text "- [blocker] …"` fails with "Option --text requires a value": the CLI reads a value that starts with `-` as an option. `--text="…"` works. The skills now pass every long value with `=`.
  Evidence: both forms run against a live terminal on 2026-10-21; the review run hit the first and recovered with the second.

- Observation: the planner answers in the owner's language (French), from the user-level `CLAUDE.md`; the files it writes follow the repository (English).
  Evidence: the `/ade:plan` reply of 2026-10-21 22:03.


## Decision Log

- Decision: a second plugin, `ade/workflow` with manifest name `ade`, holds the skills; the `router` plugin stays a pure mod.
  Rationale: plugin skills are invoked as `/<plugin>:<skill>`, so the name gives `/ade:plan`, `/ade:run-plan`, `/ade:review-pr`, which collide with no built-in command. Both folders deploy under `~/.local/share/ade/` and `CLAUDE_CODE_PLUGIN_DIRS` lists both, separated by `:`.
  Date/Author: 2026-10-21, Claude.

- Decision: everything that is computation (graph checks, ready set, tier with escalation, verdict validation, counting working agents) is in one Bun script, `ade/workflow/scripts/ade.ts`; the skills call it and keep only judgment and orchestration.
  Rationale: a model can miscount a dependency graph or a tier step; a script cannot, and it has unit tests. The script reuses `parseRouting` from `ade/router/hooks/route.ts` through the relative path `../../router/hooks/route.ts`, which is the same in the repo and in the deployed copy.
  Date/Author: 2026-10-21, Claude.

- Decision: `size: "XL"` is refused by the checker (the planner must split it); `stackOn` must also appear in `dependsOn`.
  Rationale: roadmap P1.3 says every XL issue is split, and a stacked branch cannot start before its parent exists.
  Date/Author: 2026-10-21, Claude.

- Decision: "agents working" means agents in state `starting` or `working` in `superset snapshot --json`, in workspaces whose name starts with the run name; reviewers count too.
  Rationale: the acceptance criterion counts active agents; an idle implementer waiting for review feedback uses no model and is not counted; a reviewer is an agent like any other.
  Date/Author: 2026-10-21, Claude.

- Decision: the coordinator, not the worker, pushes branches and opens pull requests, always with an explicit `--base`; preflight refuses to start when `gh repo set-default --view` is empty.
  Rationale: one place controls bases, which is what the stacking check reads; in a clone of a fork without a default repository, `gh pr create` targets the parent repository, which would open a PR upstream.
  Date/Author: 2026-10-21, Claude.

- Decision: the reviewer writes `.superset-review/verdict.json` in the worktree, and the skill adds `.superset-review/` to the repository's shared `info/exclude`; approval is recorded in the coordinator's table and as a PR comment, not as a GitHub approval.
  Rationale: the verdict must never be committed by the implementer; GitHub refuses that an account approves its own PR (roadmap D6).
  Date/Author: 2026-10-21, Claude.

- Decision: one branch and one PR for P1.3, P1.4 and P1.5 together, with one commit per milestone.
  Rationale: the three skills are only testable together (the acceptance runs all of them), and the owner asked to move fast.
  Date/Author: 2026-10-21, Claude.


## Outcomes & Retrospective

Phase 1 is done. On the VPS, `/ade:plan`, `/ade:run-plan` and `/ade:review-pr` plan a feature into checked issues, run them in parallel Superset workspaces with a hard cap on working agents, stack branches and PR bases, and loop fresh reviewers until approval or three rounds. The roadmap's Phase 1 acceptance passed on `andreagnzz/ade-sandbox`, and the review loop was checked on a planted bug.

Limits, as the roadmap expected: the run's state lives in the coordinator's context (Phase 2 M2/M3 moves it into the host); after a merge, stacked PRs must be retargeted by hand (M4); an issue can stack on one parent only, which makes the planner chain issues that need two parents' code. Three bugs were caught by running the real thing, not by reading: a JSON field name, a templated prompt, and the CLI's option parsing of values starting with `-`.


## Context and Orientation

Superset terms: a "workspace" is a git worktree (a second working folder of the same repository, on its own branch) that Superset creates under `~/.superset/worktrees/<project>/<name>`; an "agent" is a Claude Code process Superset starts in a terminal of a workspace (`superset agents create`), whose state (`starting`, `working`, `blocked`, `idle`) Superset tracks from Claude's hooks. The CLI commands used here, all verified on CLI 1.39.0: `superset projects list --local --json` (each entry has `id` and `path`, the main checkout), `superset workspaces create --local --project <id> --name <n> --branch <b> --base-branch <base> --tag <t> --json` (returns `workspace.id`), `superset workspaces get <id> --local --json` (returns `worktreePath`), `superset agents create --local --workspace <id> --agent claude --model <m> --effort <e> --prompt <text> --json` (returns `sessionId`, the terminal id), `superset agents wait --local --workspace <id> --terminal <t> --until settled --timeout <s> --json` (returns `state`), `superset terminals read … --max-lines <n> --json` (returns `text`), `superset terminals send … --text <t> --wait --until settled --timeout <s>`, `superset terminals close …`, `superset snapshot --json` (`workspaces[].name`, `workspaces[].terminals[].agent.state`).

When `--base-branch` is not given, Superset starts a workspace from the repository's default branch, read from `refs/remotes/origin/HEAD` (`resolveDefaultBranchName` in `packages/host-service/src/runtime/git/refs.ts`), and prefers a local branch of that name over `origin/<name>` (`resolveStartPoint`). A worktree's branches live in the shared repository, so a child workspace based on its parent's branch name sees the parent's commits as soon as they are committed.

Claude Code skill frontmatter (documented on code.claude.com, "skills"): `model` and `effort` set the model and effort while the skill runs; `disable-model-invocation: true` makes a skill user-only; `argument-hint` documents arguments; `${CLAUDE_PLUGIN_ROOT}` expands to the plugin folder and `${CLAUDE_SKILL_DIR}` to the skill folder; `$ARGUMENTS`, `$0`, `$1` are the arguments.

The orchestration protocol (worker envelope `SUPERSET_WORKER_DONE` / `SUPERSET_WORKER_BLOCKED`, completion only after reading the envelope and checking evidence) is Superset's own, in `plugins/superset/skills/orchestrate/SKILL.md`; the run skill follows it, except that it never runs `superset update` (this host runs the fork).


## Plan of Work

Milestone 1, `ade/workflow/scripts/ade.ts`. Pure functions, exported for tests, and a small command line: `check <issues.json>` validates the issue list (shape, unique keys, existing dependencies, no self-dependency, `stackOn` in `dependsOn`, no cycle, at least one verify command, size S/M/L, XL refused) and prints the topological order; `ready <issues.json> --done … --active … --failed …` prints the keys whose dependencies are all done and that are not started; `tier <issues.json> <key> <attempt>` prints `{ tier, model, effort }` from `routing.json` (size, one tier up per failed attempt, capped at `escalation.maxTier`); `role <name>` prints a role's `{ model, effort }`; `verdict <file>` validates a review verdict (approve must be false when a finding is `blocker` or `major`); `active <prefix>` reads `superset snapshot --json` on stdin and prints how many agents are `starting` or `working` in workspaces whose name starts with the prefix. Tests in `ade/workflow/scripts/ade.test.ts`, run with `bun test ade/workflow`.

Milestone 2, the skills. `skills/plan/SKILL.md` (+ `execplan-format.md`, a condensed ExecPlan guide for repositories that do not have this one), `skills/run-plan/SKILL.md`, `skills/review-pr/SKILL.md`, as described in Purpose and Decision Log. Deploy with `rsync` next to the router and extend `CLAUDE_CODE_PLUGIN_DIRS`.

Milestone 3, one `/ade:plan` run on the toy repository with a small feature; the output must pass `check`.

Milestone 4, the acceptance: an `issues.json` of 4 issues on the toy repository where 2 issues are stacked on others, run with `/ade:run-plan … --max-parallel 2` by a headless coordinator (`claude -p`), while a sampler records `ade.ts active` every 5 seconds.

Milestone 5, bookkeeping.


## Concrete Steps

From `/home/andrea/code/superset`:

    git switch -c feat/ade-p1-phase1-skills main
    bun test ade/workflow
    bunx biome check ade/
    rsync -a --delete --exclude='*.test.ts' ade/workflow/ ~/.local/share/ade/workflow/
    jq '.env.CLAUDE_CODE_PLUGIN_DIRS = "/home/andrea/.local/share/ade/router:/home/andrea/.local/share/ade/workflow"' \
      ~/.claude/settings.json > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json

Acceptance (from `~/code/ade-sandbox`): see Validation.


## Validation and Acceptance

Unit: `bun test ade/workflow` passes; `bunx biome check ade/` is clean.

Planner: `claude -p "/ade:plan <feature>"` in `~/code/ade-sandbox` writes `plans/<ts>-<name>.md` and `plans/<ts>-<name>.issues.json`, and `bun ~/.local/share/ade/workflow/scripts/ade.ts check <file>` prints `OK`.

Phase 1 acceptance (roadmap): with a plan of 4 issues of which 2 are stacked, run with `--max-parallel 2`: the sampler never records more than 2; each PR's base is its parent's branch for a stacked issue and `main` otherwise (`gh pr list --json number,headRefName,baseRefName`); each PR has at least one "ADE review" comment from a fresh reviewer.


## Idempotence and Recovery

The script and skills only read files except the coordinator's workspace/PR creation. A failed acceptance run is cleaned with `superset workspaces archive --local <ids>` and `gh pr close <n> --delete-branch` on the toy repository only. Rollback of the skills: remove the workflow path from `CLAUDE_CODE_PLUGIN_DIRS`.


## Artifacts and Notes

Phase 1 acceptance, 2026-10-21 22:06–22:16 local, toy repository `andreagnzz/ade-sandbox`, plan `plans/20261021-2210-acceptance.issues.json` (A and B from `main`; C stacked on A; D stacked on B), coordinator `claude -p "/ade:run-plan … --max-parallel 2" --model sonnet`:

    sampler (superset snapshot | ade.ts active "acceptance-", every ~6 s): 90 samples, max 2
        59 × 0, 9 × 1, 22 × 2
    gh pr list:
        #1 ade/acceptance/A -> main
        #2 ade/acceptance/B -> main
        #3 ade/acceptance/C -> ade/acceptance/A
        #4 ade/acceptance/D -> ade/acceptance/B
    PR comments: "ADE review, round 1: approved" on #1, #2, #3, #4
    coordinator: 4/4 done, 0 blocked, 0 failed; it re-ran `npm test` in every worktree itself.

Workers ran on `claude-haiku-5-5` at `low` (tier S), reviewers on Opus at `high` (role `review`). The coordinator started both reviewers of A and B at once when both implementers were idle (two free slots), and C and D together after A and B were approved.

The acceptance PRs were all approved at round 1, so the "changes requested" path was checked separately: PR #5 of the toy repository adds `sum(numbers)` with a planted off-by-one (`for (let i = 1; …)`) and a test that only covers `[]`, so `npm test` passes. An implementer agent (Haiku, low) sat idle in the workspace, and `claude -p "/ade:review-pr <W> 5 <T>"` ran:

    round 1: changes requested
      - [blocker] src/sum.js:3 Loop starts at i = 1, so the first element is always skipped …
      - [major] test/sum.test.js:5 Only the empty-list case is tested …
    implementer commit: "fix(sum): include the first element in the total", pushed by the skill
    round 2: approved (one minor: add negative and fractional cases)
    REVIEW_RESULT pr=5 approved=true rounds=2


## Interfaces and Dependencies

No new dependency; Bun 1.4.3 runs the script (`bun` is on PATH on the VPS). Issue shape:

    {
      "key": "A",                 // [A-Za-z0-9_-]+, unique
      "title": "Add slugify",
      "prompt": "self-contained task for a fresh agent",
      "size": "S",                // S | M | L  (XL refused: split it)
      "dependsOn": [],            // keys
      "stackOn": null,            // a key from dependsOn, or null
      "files": ["src/strings.js"],
      "acceptance": ["slugify('Hello World') returns 'hello-world'"],
      "verify": ["npm test"]      // at least one command, run from the repo root
    }

Verdict shape:

    { "approve": false, "findings": [{ "file": "src/x.js", "line": 12, "severity": "blocker|major|minor", "fix": "…" }] }


## Revision notes

2026-10-21: recorded the acceptance and the review-loop check, three fixes found by running (`path` field, heredoc prompt, `--opt=value`), and moved the plan to `plans/done/`.
