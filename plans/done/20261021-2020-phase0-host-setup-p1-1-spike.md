# Put the VPS host online and prove that a Claude Code mod can route subagents

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

Reference: This plan follows conventions from `AGENTS.md`, `packages/host-service/AGENTS.md`, `packages/trpc/AGENTS.md` and `.agents/commands/create-plan.md`. It covers "Phase 0" and "P1.1" of the roadmap `plans/20261021-1400-ade-perso-roadmap.md` (written in French).


## Purpose / Big Picture

The roadmap builds a personal agent workflow on top of Superset: a planner writes issues, a queue runs them in parallel with a model and an effort picked by rules, and a fresh reviewer loops on each pull request. Everything runs on the VPS `claude-vps` and is driven from the Superset desktop app on a Mac. Before any code of that workflow is written, two things must be true.

First, the VPS must be a Superset host that the Mac app can see and drive (Phase 0). After this plan, the owner opens the desktop app on the Mac, sees `claude-vps` in Settings → Hosts, creates a workspace on it, starts Claude in that workspace, and the host keeps running after the SSH session and the Mac are closed.

Second, the riskiest assumptions of the next milestone (P1.2, a Claude Code plugin named `router`) must be checked on the real Claude Code build of the VPS (P1.1, a "spike", which means a short, throw-away experiment whose only output is evidence). After this plan, the roadmap's Decision Log states, with transcript evidence, whether a Claude Code mod can (a) change the model of a subagent, (b) change its reasoning effort, and (c) whether `claude --dangerously-skip-permissions --permission-mode plan` starts in plan mode or in bypass mode.

No product code of the monorepo changes. The branch only adds this plan, the roadmap, a small spike mod under `plans/spikes/`, and the recorded results.


## Assumptions

The VPS is the machine this plan runs on: `hostname` prints `claude-vps`, the user is `andrea`, the OS is Linux, and `sudo` works without a password (checked on 2026-10-21 with `sudo -n true`).

Claude Code on the VPS is version 2.1.305 (`claude --version`). The mod API facts below come from the types shipped with that build. If the version changes before the spike runs, re-read the types (see Interfaces and Dependencies) before trusting them.

The Mac has SSH access to the VPS as `andrea@claude-vps` over Tailscale, because the owner already uses it daily.

The official Superset build (not this fork) is what Phase 0 installs on the VPS. The fork replaces it only in Phase 2 of the roadmap.


## Open Questions

None. Q1 to Q5 (permissions, inotify, machine id, Pro plan, publishing) were answered on 2026-10-21; the answers and their reasons are in the Decision Log.


## Progress

- [x] (2026-10-21 18:20Z) Discovery: read the roadmap, the ExecPlan template, the three AGENTS.md files, the mod API types of Claude Code 2.1.305, and checked the VPS state.
- [x] (2026-10-21 18:20Z) Phase 0 step 1 (fork): already done before this plan, see Surprises & Discoveries.
- [x] (2026-10-21 18:40Z) Owner approved this plan and answered Q1, Q2, Q3, Q5.
- [x] (2026-10-21 18:55Z) Owner answered Q4: no Pro plan. Milestone 2 switches to the VPS-only path.
- [x] (2026-10-21 18:45Z) Milestone 1: prerequisites checked; inotify raised to 1024 / 524288.
- [x] (2026-10-21 18:43Z) Milestone 2: CLI 1.39.0 installed on the VPS, owner signed in, systemd user service `superset-host` enabled and running, host `claude-vps` online in `superset hosts list`, workspace created and Claude answered in it.
- [x] (2026-10-21 19:05Z) Milestone 3: spike (a) model, (b) effort, (c) permission flags, with evidence in Artifacts and Notes.
- [x] (2026-10-21 18:50Z) Milestone 4: results recorded in this plan and in the roadmap; draft PR andreagnzz/superset#1 opened; this plan moved to `plans/done/`.


## Surprises & Discoveries

- Observation: Phase 0 step 1 of the roadmap is already done. The roadmap says the fork is still Apache Superset, but it is not.
  Evidence: `git remote -v` shows `origin https://github.com/andreagnzz/superset` and `upstream https://github.com/superset-sh/superset`; `git ls-remote origin refs/heads/main` and `git ls-remote upstream HEAD` both print `910ccfe174b26a95683a1de4bfca10d9afbbffa4`.

- Observation: the VPS has 11 GiB of RAM, not the 16 GB the roadmap assumes. This matters for the default parallelism of the queue (roadmap milestone M3, "3 agents by default").
  Evidence: `free -h` prints `Mem: 11Gi`.

- Observation: the roadmap's snippet for (a) is wrong for this build. An `agent.spawn` hook that returns `{ model: 'haiku' }` without calling `next` answers for itself and starts no subagent. The model is changed by passing a rewritten input down the chain: `next({ ...e, model: 'haiku' })`.
  Evidence: in the types of 2.1.305, `AgentSpawnInput.model` says "A hook sets this to pick the subagent's model", and `AgentSpawnResult.agentId` says "a hook that answers without `next` started none".

- Observation: the roadmap's snippet for (b) is also wrong for this build. A `tool.call` hook receives the tool's arguments flat on `e` (for example `e.command` for Bash, `e.file_path` for Edit), not under `e.input`. The rewrite is `next({ ...e, effort })`.
  Evidence: the shipped example `examples/tool-call.ts` of the `plugin-authoring` skill calls `next({ ...e, command: e.command.trim() })`; the Agent tool's input type lists `effort?: "low" | "medium" | "high" | "xhigh" | "max"` beside `prompt` and `model`.

- Observation: there is a third route for (b) that the roadmap does not list. The `turn.step` event fires before each model request, for subagents too (`e.agentId` is set), and its `effort` field is rewritable: `next({ ...e, effort })`. It does not depend on the Agent tool's `effort` argument. A hook on `turn.step` must be an async generator (`async function* ($, e, next) { return yield* next(e) }`).
  Evidence: `TurnStepInput` in the types: "A hook rewrites `model` or `effort` going down; the rest is pinned."

- Observation: a forced subagent model outranks a hook. If `CLAUDE_CODE_SUBAGENT_MODEL` with its force flag is set in the environment, the spike for (a) is meaningless.
  Evidence: `AgentSpawnInput.model`: "where the session forces one model on every subagent, that outranks a workflow agent's, a hook's included". `env | grep CLAUDE_CODE_SUBAGENT` prints nothing today.

- Observation: subagent transcripts record both the model and the effort, so the spike needs no extra logging. Each subagent writes `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl`; every line with `"type": "assistant"` carries `requestedModel`, `message.model`, `effort` and `perTurnEffort`.
  Evidence: an existing transcript from 2.1.296 has `{'requestedModel': 'claude-haiku-5-5', 'effort': 'medium', 'perTurnEffort': 'medium', 'isSidechain': True}`. Haiku accepts an effort setting.

- Observation: lingering is already on for `andrea`, so the host service will survive logout.
  Evidence: `loginctl show-user andrea` prints `Linger=yes`.

- Observation: `--dangerously-skip-permissions` always wins over `--permission-mode plan`, in both orders, headless and interactive. `--allow-dangerously-skip-permissions --permission-mode plan` starts in plan mode, with bypass one Shift+Tab away. When `--permission-mode` is given twice, the last one wins.
  Evidence: cases C1, C2, C1i, C3, C3i and C4 in Artifacts and Notes.

- Observation: `claude plugin validate` warns "gating hook without .catch" for both hooks. Without `.catch`, a hook that throws is skipped and the subagent starts with the values the caller asked for. That is the wanted behaviour for a router: a broken rule must not block subagents.
  Evidence: validate output, lines `./register.ts gating hook without .catch: agent.spawn` and `… tool.call{tool=Agent}`.

- Observation: `superset status` reports a running host as `"running": false, "stale": true` on a CLI install. This is an upstream bug of CLI 1.39.0, not an install problem. `looksLikeHostProcess` (`packages/cli/src/lib/host/process-identity.ts`) looks for `superset-host` in the process command line, but the `superset-host` wrapper script runs `exec "$SCRIPT_DIR/../lib/node" "$SCRIPT_DIR/../lib/host-service.js"`, so the command line is `…/lib/node …/lib/host-service.js`. The same check is used by `superset start` to detect a running host, so a manual `superset start` beside the service may start a second host. Use `superset hosts list` to check the host instead, and never run `superset start` by hand while the service runs.
  Evidence: `ps -o args -p <host pid>` prints `/home/andrea/superset/bin/../lib/node /home/andrea/superset/bin/../lib/host-service.js`; the service log says `registered as host a2b72f131601cda18cd79ec8d89ac275` and `Connected to relay`; `superset hosts list` prints `"online": "yes"`.

- Observation: every new worktree stops Claude Code on its "Is this a project you created or one you trust?" dialog before the prompt runs, even with `--dangerously-skip-permissions`. An unattended queue (roadmap P1.4 and M3) would block on it for every issue. Root cause: a worktree inherits trust from its project's main checkout, and Superset by design never pre-trusts a folder that holds existing user content (`packages/host-service/src/trpc/router/workspace-creation/shared/seed-agent-trust.ts`; it only seeds session folders it scaffolds itself). Rule for P1.4 and M3: the main checkout of each project must be trusted once (`projects["<main checkout>"].hasTrustDialogAccepted: true` in `~/.claude.json`). Verified: with `~/code/ade-sandbox` trusted, a second workspace (`trust-check`) started and answered with no dialog.
  Evidence: `superset agents wait --until settled` timed out with "agent is starting"; `superset terminals read` showed the dialog; `superset terminals send --keys down,enter` released it.

- Observation: on a fresh host, `superset workspaces create --agent claude` failed with "No host agent config matching 'claude'" until `superset agents list --local` had run once; after that the built-in configs existed and the same command worked. `workspaces create --project` also requires `--name`.
  Evidence: the two error messages, then a successful `workspaces create` right after `agents list`.

- Observation: on a headless machine, `superset auth login` prints an authorize URL whose redirect is `https://app.superset.sh/cli/auth/code`; the web page shows a `<code>#<state>` value to paste back into the waiting CLI. The paste prompt has no timeout. The code only works with the PKCE verifier held by that CLI process.
  Evidence: `packages/cli/src/lib/auth.ts` (`PASTE_REDIRECT_PATH`, `parsePastedCode`) and the login run in `tmux`.

- Observation: `systemctl --user` fails from this agent's shell with "Failed to connect to bus: No medium found", because the shell has no `XDG_RUNTIME_DIR`. A normal SSH login sets it. `superset hosts add` runs over SSH, so this is expected to be fine, but Milestone 2 checks it.


## Decision Log

- Decision: run the spike mod only in child `claude -p` processes started with `--plugin-dir`, and never write it under `~/.claude/dev-mods/` or into `CLAUDE_CODE_PLUGIN_DIRS`.
  Rationale: a mod written under the dev-mods folder of the authoring session hot-loads into that session and would rewrite the models of the authoring agent's own subagents. `claude -p --plugin-dir <folder>` loads the plugin fresh for one process only.
  Date/Author: 2026-10-21, Claude (plan).

- Decision: keep the spike mod in the fork under `plans/spikes/20261021-p1-1-router-spike/`.
  Rationale: it is evidence and a re-runnable check after each Claude Code update (roadmap section 11), and `biome.json` excludes `**/plans` from lint, so it adds no CI surface and no upstream merge conflicts. The real `router` plugin of P1.2 lives elsewhere (the `claude-setup` repo or a dedicated repo).
  Date/Author: 2026-10-21, Claude (plan).

- Decision: run the spike's main cases with `--setting-sources local` in an empty temporary folder, then repeat the final case once with the default setting sources.
  Rationale: the owner's user settings enable other plugins (ponytail has a `SubagentStart` hook, user `effortLevel` is `high`, user `model` is `sonnet`). Isolated runs show what the mod alone does; the last run shows whether the other plugins interfere.
  Date/Author: 2026-10-21, Claude (plan).

- Decision: test effort on a value that differs from the baseline run, `low` by default.
  Rationale: a rewrite to the value the subagent would get anyway proves nothing.
  Date/Author: 2026-10-21, Claude (plan).

- Decision (Q1): keep `--dangerously-skip-permissions` in the `claude` preset for now.
  Rationale: the Phase 1 queue cannot handle agents that stop in `blocked` for an approval. The choice is reversible in the host's agent settings, without code.
  Date/Author: 2026-10-21, owner.

- Decision (Q2): raise inotify to 1024 instances and 524288 watches in `/etc/sysctl.d/60-superset-inotify.conf`.
  Rationale: 128 instances is too low for one watcher per worktree.
  Date/Author: 2026-10-21, owner.

- Decision (Q3): keep the current `/etc/machine-id`.
  Rationale: the VPS is a single Contabo machine and the only Linux host of the account, so no other host can share its id. Regenerating it on a running VPS can change network identifiers derived from it (for example a DHCP client id), so it is done only if a second host built from the same image is added.
  Date/Author: 2026-10-21, owner and Claude.

- Decision (Q4): no Pro plan. Phase 0 is done on the VPS alone: install the CLI there, sign in, start the host, and drive it with the CLI over SSH. The paid Remote Access feature is not rebuilt or bypassed in the fork.
  Rationale: Remote Access is a paywalled feature (`GATED_FEATURES.REMOTE_ACCESS`, `apps/desktop/src/renderer/components/Paywall/`), and the Elastic License 2.0 of the repository forbids circumventing functionality protected by the license. Roadmap phases 1 and 2 run entirely on the VPS through the CLI and do not need it; only phase 3 (the Mac app driving the VPS) does.
  Date/Author: 2026-10-21, owner and Claude.

- Decision (Q5): push the branch to `origin` and open a draft PR against the fork's `main`.
  Rationale: the roadmap asks for one PR per milestone.
  Date/Author: 2026-10-21, owner.

- Decision: write `~/.config/systemd/user/superset-host.service` by hand, with the exact content `systemdUnit()` produces in `packages/cli/src/lib/ssh-host-setup/service.ts` (`ExecStart="/home/andrea/superset/bin/superset" start --org "<organization id>"`, `Restart=on-failure`, `RestartSec=5`, `KillMode=process`, `WantedBy=default.target`), then `systemctl --user daemon-reload`, `enable`, `start`.
  Rationale: `superset hosts add` writes this unit, but it runs from a client over SSH; without Pro there is no client. Same file, so a later `hosts add` sees it as unchanged. Lingering is on, so the service starts at boot without a login. A real reboot was not tested because other services run on the VPS.
  Date/Author: 2026-10-21, Claude.

- Decision: use a new local toy repository `~/code/ade-sandbox` (one commit, no remote) as Superset project `ade-sandbox` (id `437aeaae-b674-4b77-ab34-d4ae154f3015`) for the acceptance check, not this monorepo.
  Rationale: a workspace of the monorepo could run its setup scripts and install dependencies on an 11 GiB machine for a smoke test. The roadmap's Phase 1 acceptance needs a toy repo anyway; it will need a GitHub remote then.
  Date/Author: 2026-10-21, Claude.

- Decision (spike (a)): a mod changes a subagent's model with `on('agent.spawn', …)` and `next({ ...e, model })`, even when the caller passed an explicit `model`. P1.2 uses this. The fallback `CLAUDE_CODE_SUBAGENT_MODEL` is not needed.
  Rationale: case A1 ran the subagent on `claude-haiku-5-5` while the parent asked for `sonnet`; baseline A0 ran it on `claude-sonnet-5-5`.
  Date/Author: 2026-10-21, Claude (spike).

- Decision (spike (b)): a mod changes a subagent's effort with `on('tool.call', { tool: 'Agent' }, …)` and `next({ ...e, effort })`. The `turn.step` and classic `PreToolUse` routes were not needed and were not tested.
  Rationale: case B1 recorded `effort: "low"` against `medium` in A0; case AB combined both rewrites; case U1 gave the same result with the owner's user plugins loaded.
  Date/Author: 2026-10-21, Claude (spike).

- Decision (spike (c)): roadmap milestone M0 cannot simply append `--permission-mode plan` to the current `claude` preset, because `--dangerously-skip-permissions` overrides it. M0 must change how the preset grants bypass, for example `claude --allow-dangerously-skip-permissions --permission-mode bypassPermissions`, so that a mode appended later (`--permission-mode plan`) wins as the last flag. M0's own ExecPlan decides, and must check the resume and fork commands of the preset too.
  Rationale: C1, C2 and C1i stayed in bypass mode and created the file; C3, C3i and C4 started in plan mode and did not.
  Date/Author: 2026-10-21, Claude (spike).


## Outcomes & Retrospective

Both goals are met. The VPS is a Superset host (`claude-vps`, online, systemd user service, relay connected) driven with the CLI, and a Claude agent launched by Superset ran in a workspace on it. The Mac app does not drive it because the account has no Pro plan; that only matters for roadmap phase 3. The spike proved that one small mod can set a subagent's model (`agent.spawn`) and effort (`tool.call` on `Agent`) on Claude Code 2.1.305, so P1.2 can start from `plans/spikes/20261021-p1-1-router-spike/hooks/register.ts`. It also showed that roadmap M0 needs a different preset command.

Three findings change later work. The trust dialog on each new worktree must be handled before any unattended run (P1.4, M3). `superset status` is wrong for CLI-installed hosts (upstream bug in `looksLikeHostProcess`), so checks must use `superset hosts list`. The VPS has 11 GiB of RAM, not 16.

Lesson: the roadmap's API snippets were written from documentation and two were wrong; reading the types shipped with the installed build first caught both before any code was written.


## Context and Orientation

Superset is an "agent-first development platform": an Electron desktop app (`apps/desktop`), a CLI (`packages/cli`, binary `superset`), and a local server per machine called the host service (`packages/host-service`, binary `superset-host`). A "host" is a machine that runs the host service; a "workspace" is an isolated git checkout (a git worktree, meaning a second working folder that shares the same repository) on a host, where terminals and coding agents run. The desktop app on one machine can drive a host on another machine through Superset's relay; the docs call this Remote Access and it needs the Pro plan.

No app and no package of the monorepo changes in this plan. The only repository files touched are under `plans/`. The roadmap's later milestones touch `packages/host-service`, `packages/shared` and `apps/desktop`; their compatibility rules (additive tRPC changes only, a client must handle a host that lacks a new procedure, raise `MIN_HOST_SERVICE_VERSION` in `packages/shared/src/host-version.ts` when a client needs a newer host) do not apply here because no procedure changes.

The command `superset hosts add <user>@<machine>` (file `packages/cli/src/commands/hosts/add/command.ts`) is run on the client machine (the Mac). Over SSH it checks `/etc/machine-id` with `machineIdProblem`, installs the Superset CLI into `~/superset` on the remote machine with the script at `https://superset.sh/cli/install.sh`, signs that CLI in with a new API key of your account, writes a systemd user service `~/.config/systemd/user/superset-host.service` (or a plain background process when no systemd user session exists), and asks whether to enable "lingering" (`loginctl enable-linger`, which keeps user services running after logout).

The command `superset update`, the flag `superset start --auto-update`, and the "Update host" button of the app download the official build (`ROLLING_DOWNLOAD_BASE` in `packages/cli/src/commands/update/command.ts`). That is harmless during this plan because the official build is what runs. It becomes forbidden in Phase 2, once the fork's build replaces it.

The built-in `claude` preset (`packages/shared/src/builtin-terminal-agents.ts`) runs `claude --dangerously-skip-permissions`. When an agent is launched with a "mode", the host appends the mode's arguments after the model and effort arguments (`buildTerminalAgentLaunch` in `packages/host-service/src/trpc/router/agents/agents.ts`: `buildAgentCommandString(config, prompt, [...modelArgs, ...effortArgs, ...modeArgs], …)`). Today only the `omp` preset has a mode (`AGENT_MODE_SUPPORT` in `packages/shared/src/agent-models.ts`). Roadmap milestone M0 wants to add `{ presetId: "claude", modes: [{ id: "plan", label: …, args: ["--permission-mode", "plan"] }] }`. The command line would then be `claude --dangerously-skip-permissions … --permission-mode plan`. Spike (c) finds out which of the two flags wins.

Claude Code terms used below. A "subagent" is a child agent that Claude starts with its `Agent` tool; it has its own model, effort and transcript. "Effort" is how much the model reasons before it answers (`low`, `medium`, `high`, `xhigh`, `max`). A "plugin" is a folder with `.claude-plugin/plugin.json`. A "mod" is a plugin whose behaviour lives in a TypeScript "hooks module": `hooks/hooks.json` names the module, and the module exports `register(on, options)`. `on(event, matcher?, hook)` adds a hook; every hook is `($, e, next)`, where `$` is the engine interface (for example `$.env.get("HOME")`), `e` is the event's input, and `next(e)` runs the rest of the chain and the engine's own behaviour. A hook changes what happens by calling `next` with a rewritten input. The events this plan uses are `agent.spawn` (a subagent is about to start; `e.model` is rewritable), `tool.call` with the matcher `{ tool: 'Agent' }` (the Agent tool is about to run; its arguments, including `effort`, are on `e`), and, as a fallback, `turn.step` (a model request is about to be sent; `e.effort` is rewritable, `e.agentId` is set inside a subagent). A "classic hook" is a shell command declared under `hooks` in a settings file; its `PreToolUse` event can return `hookSpecificOutput.updatedInput` to replace a tool's arguments.


## Plan of Work

Milestone 1 prepares the VPS. The agent working on the VPS checks the prerequisites that `superset hosts add` needs and raises the inotify limits. Nothing in the repository changes. At the end, the VPS meets every check of roadmap Phase 0 step 3.

Milestone 2 changed after Q4 (no Pro plan): it runs on the VPS. The agent downloads `https://superset.sh/cli/install.sh`, reads it, and runs it; the owner signs the CLI in (`~/superset/bin/superset auth login`, or `--api-key=-` with a key created in the web app); the agent starts the host without auto-update and checks `superset status`, then creates a workspace and an agent with the CLI. How the host survives a reboot (a systemd user unit like the one `hosts add` writes) is settled in that step and recorded here. The original Mac path below applies only with Pro. It was: the owner works on the Mac, because it needs the Mac app, a browser sign-in and SSH from the Mac. The owner installs the desktop app, signs in, takes Pro if Q4 says so, installs the Superset CLI on the Mac if `superset` is not on the Mac's `PATH`, and runs `superset hosts add andrea@claude-vps`. The agent then checks the host from the VPS side. At the end, the Phase 0 acceptance of the roadmap holds.

Milestone 3 is the spike. It can run before or in parallel with Milestone 2, because it only needs Claude Code on the VPS. The agent creates a three-file mod plus a runner script under `plans/spikes/20261021-p1-1-router-spike/`, validates it with `claude plugin validate`, and runs a fixed set of cases with `claude -p`. Each case prints the model and effort that the subagent actually ran with, read from its transcript. Time box: half a day. If a case fails, the agent tries the next route listed for that question before it concludes.

The mod has two hooks and reads its targets from environment variables, so one mod serves every case. The `agent.spawn` hook reads `ROUTER_SPIKE_MODEL` and, when it is set, calls `next({ ...e, model })`; otherwise it calls `next(e)`. The `tool.call` hook on `Agent` reads `ROUTER_SPIKE_EFFORT`, checks that it is one of `low`, `medium`, `high`, `xhigh`, `max` (a type guard, so the value is typed without a cast), and calls `next({ ...e, effort })`; otherwise `next(e)`. If the `tool.call` route does not change the effort, the agent adds the `turn.step` route (an async generator that rewrites `e.effort` when `e.agentId` is set) behind a third variable `ROUTER_SPIKE_EFFORT_VIA=turn-step`, and, if that also fails, tries a classic `PreToolUse` hook passed with `--settings` that returns the full Agent input with `effort` changed in `hookSpecificOutput.updatedInput`.

The runner script `run.sh` creates an empty temporary folder, runs one `claude -p` there with the spike plugin and a fixed parent prompt, takes the `session_id` from the JSON output, finds that session's subagent transcripts, and prints one line per distinct `{requestedModel, model, effort}`. The parent prompt asks for exactly one Agent call, in the foreground (`run_in_background: false`, because a headless run may exit before a background subagent writes its transcript), with an explicit `model: "sonnet"` and the subagent prompt "Reply with the single word OK.". The explicit model makes the test strict: the hook must override what the caller asked for.

Spike (c) needs no mod. The agent runs `claude -p` with the permission flags in an empty folder, asks it to create a file, and records two observations per flag combination: the `permissionMode` field of the first stream-json event (the `system`/`init` event), and whether the file exists afterwards. Then the agent checks the combination that M0 would produce in an interactive session, because Superset runs Claude interactively in a terminal: it starts it in `tmux` and reads the mode shown in the footer.

Milestone 4 writes the results down. The agent fills the Decision Log of this plan and of the roadmap (with dates and evidence), ticks the roadmap's Progress lines for Phase 0 and P1.1, corrects the two wrong snippets in the roadmap (decision D5 in section 4 and P1.1 (b) in section 7) so that P1.2 starts from the right API, writes Outcomes & Retrospective, moves this plan to `plans/done/`, commits, pushes and opens the draft PR if Q5 says yes.

Commits, in English, small and atomic, without any tool stamp or co-author trailer:

    docs(plans): add ADE roadmap and Phase 0 / P1.1 ExecPlan
    chore(plans): add P1.1 router spike mod and runner
    docs(plans): record Phase 0 and P1.1 spike results


## Concrete Steps

All commands run on the VPS, in `/home/andrea/code/superset`, unless a step says "on the Mac".

Step 0, branch. Run once; the second form is safe to re-run.

    git switch -c chore/ade-phase0-p1-1-spike || git switch chore/ade-phase0-p1-1-spike
    git add plans/20261021-1400-ade-perso-roadmap.md plans/20261021-2020-phase0-host-setup-p1-1-spike.md
    git commit -m "docs(plans): add ADE roadmap and Phase 0 / P1.1 ExecPlan"

Milestone 1, prerequisites (read-only checks):

    cat /etc/machine-id                      # 32 hex characters; uniqueness per Q3
    gh auth status                           # "Logged in to github.com account andreagnzz"
    loginctl show-user andrea -p Linger      # Linger=yes
    ls ~/superset 2>&1                       # "No such file or directory" before hosts add
    env | grep -E 'CLAUDE_CODE_SUBAGENT|CLAUDE_CODE_EFFORT_LEVEL'   # prints nothing

Milestone 1, inotify (only after Q2 is answered yes). Writing the same file twice gives the same result, so the step is idempotent:

    printf 'fs.inotify.max_user_instances = 1024\nfs.inotify.max_user_watches = 524288\n' \
      | sudo tee /etc/sysctl.d/60-superset-inotify.conf
    sudo sysctl --system | grep inotify
    sysctl fs.inotify.max_user_instances fs.inotify.max_user_watches
    # Expected:
    # fs.inotify.max_user_instances = 1024
    # fs.inotify.max_user_watches = 524288

Milestone 2, on the Mac (owner):

    # 1. Install the Superset desktop app, open it, sign in. Take Pro if Q4 = yes.
    # 2. If `superset` is not found in a Mac terminal:
    curl -fsSL https://superset.sh/cli/install.sh | sh
    # 3. Check SSH and the systemd user session from the Mac:
    ssh andrea@claude-vps 'systemctl --user is-system-running'
    # Expected: "running" or "degraded". Anything else: the host will run as a
    # plain background process and will not survive a reboot.
    # 4. Add the host. Accept the CLI install and the sign-in; lingering is already on.
    superset hosts add andrea@claude-vps

Milestone 2, back on the VPS (agent), after the owner says the command finished:

    ~/superset/bin/superset --version
    ~/superset/bin/superset status
    # Expected: the host is shown online.
    systemctl --user status superset-host --no-pager | head -5
    # Run from a real SSH login if this shell has no user bus.
    # Expected: "active (running)".

Milestone 3, spike files. Create the folder `plans/spikes/20261021-p1-1-router-spike/` with these files (content in Interfaces and Dependencies): `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`, `run.sh` (executable), `.gitignore` (one line, `.claude-plugin/types/`, because the engine writes about 22,000 lines of generated types there on first load). Then:

    claude plugin validate plans/spikes/20261021-p1-1-router-spike
    # Expected: no error; the report lists the hooks agent.spawn and tool.call (Agent)
    # and the environment variables ROUTER_SPIKE_MODEL and ROUTER_SPIKE_EFFORT.
    git add plans/spikes/20261021-p1-1-router-spike
    git commit -m "chore(plans): add P1.1 router spike mod and runner"

Milestone 3, spike (a) and (b). Each line is one `claude -p` run with tiny prompts (Sonnet parent, one subagent). `S=plans/spikes/20261021-p1-1-router-spike`.

    $S/run.sh                                           # A0 baseline
    # Expected: requestedModel claude-sonnet-*, effort = the default (note it)
    ROUTER_SPIKE_MODEL=haiku $S/run.sh                  # A1 model rewrite
    # Expected if (a) holds: requestedModel claude-haiku-*
    ROUTER_SPIKE_EFFORT=low $S/run.sh                   # B1 effort via tool.call
    # Expected if (b) holds: effort "low" (choose another value if A0 was already low)
    ROUTER_SPIKE_MODEL=haiku ROUTER_SPIKE_EFFORT=low $S/run.sh          # AB both
    ROUTER_SPIKE_MODEL=haiku ROUTER_SPIKE_EFFORT=low SPIKE_USER_SETTINGS=1 $S/run.sh   # U1 with user plugins
    # Expected: same as AB. A difference means another plugin interferes.

If B1 fails, add the `turn.step` hook and run `ROUTER_SPIKE_EFFORT=low ROUTER_SPIKE_EFFORT_VIA=turn-step $S/run.sh` (B2); if that fails, run B3 with the classic hook (see Interfaces and Dependencies). If A1 fails, confirm the roadmap's fallback once: `CLAUDE_CODE_SUBAGENT_MODEL=haiku CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 $S/run.sh` (expected: haiku).

Milestone 3, spike (c). Each case in a fresh empty folder:

    d=$(mktemp -d) && cd "$d"
    claude -p --model sonnet --setting-sources local --output-format stream-json --verbose \
      --dangerously-skip-permissions --permission-mode plan \
      "Create a file named probe.txt containing hi, then reply DONE." \
      | head -1 | jq -r .permissionMode
    ls probe.txt 2>&1
    # C1. Record: the printed mode, and whether probe.txt exists.
    # C2: same with the two flags swapped.
    # C3: --allow-dangerously-skip-permissions --permission-mode plan

Then the interactive check of the M0 command line:

    d=$(mktemp -d)
    tmux new-session -d -s spikec -c "$d" 'claude --dangerously-skip-permissions --permission-mode plan'
    # wait until the prompt is drawn (a few seconds), then:
    tmux capture-pane -p -t spikec | tail -5
    # Record the mode in the footer ("plan mode on" or "bypass permissions on").
    tmux kill-session -t spikec

Milestone 4:

    git add plans/
    git commit -m "docs(plans): record Phase 0 and P1.1 spike results"
    git push -u origin chore/ade-phase0-p1-1-spike      # only if Q5 = yes


## Validation and Acceptance

Phase 0 is accepted when all three hold. On the Mac, the desktop app lists `claude-vps` in Settings → Hosts and shows it online. From the app, creating a workspace on `claude-vps` and starting Claude in it shows a working Claude session in the terminal. On the VPS, `~/superset/bin/superset status` shows the host online, and it still does after the owner closes every SSH session to the VPS and reconnects later. If Q4 is "no Pro", the first two checks are replaced by `superset workspaces create` and `superset agents create` run over SSH on the VPS.

Spike P1.1 is accepted when each of (a), (b) and (c) has a verdict in the roadmap's Decision Log with the transcript lines that prove it. A verdict can be negative: "does not work on 2.1.305, fallback X confirmed" is an accepted result. The verdict for (c) names the mode that wins for each of C1, C2, C3 and for the interactive run, and says whether M0 can reuse the `claude` preset.

Repository checks. The diff contains only files under `plans/`:

    git diff --stat main...HEAD
    # Expected: only plans/... paths
    bun run lint
    # Expected: same result as on main (biome.json excludes **/plans)

`bun run typecheck` and `bun test` are not needed because no package changes; running them proves nothing about this plan.


## Idempotence and Recovery

The read-only checks can be repeated at will. The inotify file is overwritten with the same content on a re-run; to undo it, delete `/etc/sysctl.d/60-superset-inotify.conf` and run `sudo sysctl --system` (values return to the defaults at the next boot, or set them back with `sudo sysctl -w`).

`superset hosts add` can be run again: it detects an installed CLI and an existing sign-in. To remove the host, run `superset hosts remove` on the Mac (see `superset hosts remove --help` before use).

The spike changes nothing outside its temporary folders and the transcript files under `~/.claude/projects/`, which are ordinary session logs. If a run hangs, stop it with Ctrl-C; the next run starts from a new empty folder. If `--setting-sources local` breaks authentication, run without it and record that in Surprises & Discoveries.

Git: every step works on the branch `chore/ade-phase0-p1-1-spike`; nothing is force-pushed and `main` is never changed.


## Artifacts and Notes

Claude Code 2.1.305, 2026-10-21. Cases A and B print what the subagent ran with, read from its transcript by `run.sh`. Every run exited 0.

    A0  (no rewrite)                         {"requestedModel":"claude-sonnet-5-5","model":"claude-sonnet-5-5","effort":"medium"}
    A1  ROUTER_SPIKE_MODEL=haiku             {"requestedModel":"claude-haiku-5-5","model":"claude-haiku-5-5","effort":"medium"}
    B1  ROUTER_SPIKE_EFFORT=low              {"requestedModel":"claude-sonnet-5-5","model":"claude-sonnet-5-5","effort":"low"}
    AB  both                                 {"requestedModel":"claude-haiku-5-5","model":"claude-haiku-5-5","effort":"low"}
    U1  both, user settings and plugins on   {"requestedModel":"claude-haiku-5-5","model":"claude-haiku-5-5","effort":"low"}

Case C prints the `permissionMode` of the stream-json `init` event and whether the agent created `probe.txt`. Interactive cases (suffix `i`) show the footer of `claude` started in `tmux`.

    C1   --dangerously-skip-permissions --permission-mode plan        mode=bypassPermissions probe=created
    C2   --permission-mode plan --dangerously-skip-permissions        mode=bypassPermissions probe=created
    C3   --allow-dangerously-skip-permissions --permission-mode plan  mode=plan probe=absent
    C4   --allow-dangerously-skip-permissions --permission-mode bypassPermissions --permission-mode plan
                                                                       mode=plan probe=absent
    C1i  --dangerously-skip-permissions --permission-mode plan        ⏵⏵ bypass permissions on (shift+tab to cycle)
    C3i  --allow-dangerously-skip-permissions --permission-mode plan  ⏸ plan mode on (shift+tab to cycle)

Phase 0 acceptance on the VPS (no Pro plan), 2026-10-21:

    $ superset hosts list
    [{"id":"a2b72f131601cda18cd79ec8d89ac275","name":"claude-vps","online":"yes"}]
    $ systemctl --user status superset-host
    Active: active (running) since Wed 2026-10-21 20:38:12 CEST
    $ superset workspaces create --local --project 437aeaae-… --name phase0-check --branch phase0-check \
        --agent claude --model haiku --effort low --prompt "Reply with the single word OK."
    "agents": [{"ok": true, "kind": "terminal", "label": "Claude"}]
    (trust dialog accepted with: superset terminals send --keys down,enter)
    $ superset agents wait --until settled
    {"state": "idle", "lastEventType": "Stop"}
    $ superset terminals read
    Haiku 5.5 with low effort · Claude Max
    ❯ Reply with the single word OK.
    ● OK
    ⏵⏵ bypass permissions on

The test workspace was archived afterwards; the project `ade-sandbox` stays for Phase 1.


## Interfaces and Dependencies

No new dependency. The spike uses Claude Code 2.1.305, `jq` 1.7 (present at `/usr/bin/jq`), and `tmux` (present at `/usr/bin/tmux`).

The mod API types for this build are at `/tmp/claude-1001/bundled-skills/2.1.305/5f106e4e08fdf77fd7c42cb57e6f27cc/plugin-authoring/types/claude-code.d.ts` while the authoring session runs, and at `plans/spikes/20261021-p1-1-router-spike/.claude-plugin/types/claude-code/index.d.ts` once the engine has loaded the mod. Grep them for `AgentSpawnInput`, `TurnStepInput` and `BuiltinToolInputs`.

`plans/spikes/20261021-p1-1-router-spike/.claude-plugin/plugin.json`:

    { "name": "router-spike", "version": "0.1.0", "description": "P1.1 spike: rewrite a subagent's model and effort" }

`plans/spikes/20261021-p1-1-router-spike/hooks/hooks.json`:

    { "modules": ["./register.ts"] }

`plans/spikes/20261021-p1-1-router-spike/hooks/register.ts`, the shape the hooks must have:

    import type { Register } from 'claude-code'

    const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
    type Effort = (typeof EFFORTS)[number]
    const isEffort = (value: string | undefined): value is Effort =>
      EFFORTS.some(effort => effort === value)

    export const register: Register = on => {
      on('agent.spawn', async ($, e, next) => {
        const model = await $.env.get('ROUTER_SPIKE_MODEL')
        return next(model ? { ...e, model } : e)
      })

      on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
        const effort = await $.env.get('ROUTER_SPIKE_EFFORT')
        return next(isEffort(effort) ? { ...e, effort } : e)
      })
    }

The `turn.step` fallback, added only if B1 fails, gated by `ROUTER_SPIKE_EFFORT_VIA=turn-step` (and the `tool.call` hook then passes `e` through unchanged):

    on('turn.step', async function* ($, e, next) {
      const effort = await $.env.get('ROUTER_SPIKE_EFFORT')
      const via = await $.env.get('ROUTER_SPIKE_EFFORT_VIA')
      const rewrite = via === 'turn-step' && e.agentId !== undefined && isEffort(effort)
      return yield* next(rewrite ? { ...e, effort } : e)
    })

The classic-hook fallback (B3), only if B2 also fails: a shell script that reads the PreToolUse input from stdin and prints the whole Agent input back with `effort` changed, passed to `run.sh` through `--settings`:

    jq -c '{hookSpecificOutput: {hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: (.tool_input + {effort: "low"})}}'

`plans/spikes/20261021-p1-1-router-spike/run.sh` (bash, `set -euo pipefail`). Behaviour: resolve its own folder; create a temporary folder and `cd` into it; run `claude -p --model sonnet --dangerously-skip-permissions --plugin-dir <spike folder> --output-format json`, adding `--setting-sources local` unless `SPIKE_USER_SETTINGS=1`, passing any extra arguments of `run.sh` through, with this prompt:

    Call the Agent tool exactly once with subagent_type "general-purpose",
    model "sonnet", run_in_background false, description "spike probe" and
    prompt "Reply with the single word OK.". Then reply DONE.

Then read `session_id` from the JSON result, find `~/.claude/projects/*/<session_id>/subagents/*.jsonl`, and print `jq -c 'select(.type=="assistant") | {requestedModel, model: .message.model, effort}' | sort -u`. If no subagent transcript exists, print the parent's final `result` text and exit 1, so a run where the parent skipped the Agent call cannot pass silently.


## Revision notes

2026-10-21: recorded the owner's answers (Q1 to Q5), the Milestone 1 result and the spike results (a), (b), (c). Milestone 2 moved from the Mac to the VPS because the owner has no Pro plan, so the relay-based Remote Access is not available.

2026-10-21: Milestone 2 done on the VPS without Pro (CLI install, sign-in, hand-written systemd unit, toy project, workspace and agent check). Recorded the `superset status` false negative, the per-worktree trust dialog and the lazily seeded agent configs. Plan moved to `plans/done/`.

2026-10-21: after the owner asked to fix the bugs found: recorded the trust-dialog root cause and rule, and the fork fixes for `superset status` (andreagnzz/superset#2) and the lazily seeded agent configs (andreagnzz/superset#3).
