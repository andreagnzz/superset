# Pick the model and effort of agent launches that name neither, from routing.json, on the host

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

Reference: This plan follows conventions from `AGENTS.md`, `packages/host-service/AGENTS.md`, `packages/trpc/AGENTS.md` and `.agents/commands/create-plan.md`. It is milestone "M1" of the roadmap `plans/20261021-1400-ade-perso-roadmap.md` (written in French).


## Purpose / Big Picture

Today, an agent launched on the VPS host without `--model` and `--effort` runs on Claude's defaults. After this plan, when the file `routing.json` sits next to the host's database (`~/.superset/host/<organization id>/routing.json`), every fresh Claude launch that names neither a model nor an effort gets both from it: the first rule whose pattern matches the prompt picks a tier (for example "fix typo in README" picks tier S, Haiku at low effort), otherwise the fallback tier. A launch that names a model or an effort, a resume and a fork keep their own. The host log gets one line per routed launch: `[routing] model=haiku effort=low reason=rule /typo|…/ -> S`. Without the file nothing changes.

To see it: `superset agents create --local --workspace <id> --agent claude --prompt "fix typo in README"` starts Claude with `--model haiku --effort low` (its header reads "Haiku … with low effort").


## Assumptions

The file format is the one of `ade/router/routing.json` (P1.2): `tiers`, `roles`, `rules`, `fallbackTier`. The VPS runs this fork's host built from `main`.


## Open Questions

None.


## Progress

- [x] (2026-10-21 20:40Z) `packages/shared/src/agent-launch-estimator.ts` with tests (5 pass).
- [x] (2026-10-21 20:45Z) Host wiring: `launchRoutingFile` in the request context, `buildTerminalAgentLaunch` routes a fresh launch; 3 host tests; `agents`, `workspaces`, `workspace-creation` suites pass (404 tests); typecheck of `shared` and `host-service` clean; Biome clean.
- [x] (2026-10-21 20:37Z) Fork built from `main` (Docker, CI steps, headless E2E passed), installed on the VPS (`~/superset`; previous fork in `~/superset-fork-prev`), `routing.json` linked, acceptance passed.


## Surprises & Discoveries

None yet.


## Decision Log

- Decision: enable routing by the presence of `routing.json` next to `host.db`, not by a new `host_settings` column.
  Rationale: a column needs a host migration (`packages/host-service/drizzle/0038_…`). Upstream adds host migrations too; the weekly sync would then carry two different `0038` migrations, and hosts that already ran the fork's would diverge from upstream's journal. A file needs no migration, and its absence is the "disabled" state the roadmap asked for. The VPS links it to the router's copy, so subagents (P1.2) and launches (M1) read one file.
  Date/Author: 2026-10-21, Claude.

- Decision: thread the path as an optional `launchRoutingFile` on `HostServiceContext`, set only in the request context of `createApp`, and pass it to `buildTerminalAgentLaunch(db, input, { routingFile })`.
  Rationale: every launch a person or an automation starts comes through a tRPC request (CLI, desktop, relay); resumes are excluded by rule; the sandbox launch path is cloud-only. A parameter keeps tests free of module mocks (`AGENTS.md`, Tests).
  Date/Author: 2026-10-21, Claude.

- Decision: route inside `buildTerminalAgentLaunch`, right after `resolveAgentLaunchPresetId` and before the model and effort validators, never at the top of `runAgentInWorkspace`.
  Rationale: the roadmap's rule: `continuationConfig` and `chatLaunchTarget` refuse an input that carries a model or an effort, so routing earlier would break automation continuations and chat launches. The routed values then pass the same validators as user values.
  Date/Author: 2026-10-21, Claude.

- Decision: a `routing.json` that does not parse turns routing off for that launch and logs a warning; it never fails the launch.
  Rationale: a typo in a rules file must not stop every agent on the host.
  Date/Author: 2026-10-21, Claude.

- Decision: the estimator duplicates the small parser of `ade/router/hooks/route.ts`.
  Rationale: the mod runs inside Claude Code's plugin sandbox and can import only its own files, and `packages/shared` cannot import from `ade/`; the two parsers read the same format and each has its tests.
  Date/Author: 2026-10-21, Claude.


## Outcomes & Retrospective

Done. Launches on the VPS host that name no model or effort now follow the same `routing.json` as subagents, and the file's link is the on/off switch. The `size` and `role` inputs of the estimator are unused until a host-side caller passes them (roadmap M3 and M5).


## Context and Orientation

`packages/host-service` is the per-machine server (the "host") that the desktop app, the CLI and the relay call through tRPC. `buildTerminalAgentLaunch` in `packages/host-service/src/trpc/router/agents/agents.ts` turns an `AgentRunInput` (agent, prompt, optional model, effort, mode, resume or fork session) into the shell command typed into a new terminal; it resolves the host agent config, validates model, effort and mode for the preset, and appends `--model`/`--effort` through `buildAgentModelArgs` and `buildAgentEffortArgs` from `packages/shared/src/agent-models.ts`. Its callers are `runTerminalAgent` (same file, used by `agents.run` and workspace creation) and the setup-chained launch in `packages/host-service/src/trpc/router/workspaces/workspaces.ts`. `createApp` in `packages/host-service/src/app.ts` builds the per-request context (`createContext`); `config.dbPath` is `~/.superset/host/<organization id>/host.db`.

No tRPC procedure, input or output changes, so the compatibility rules of `packages/trpc/AGENTS.md` are not engaged and `MIN_HOST_SERVICE_VERSION` stays.


## Plan of Work

Add `packages/shared/src/agent-launch-estimator.ts` (`parseLaunchRules`, `estimateAgentLaunch`, only for the `claude` preset) with tests, and export it as `@superset/shared/agent-launch-estimator`. Add `launchRoutingFile?: string` to `HostServiceContext` (`packages/host-service/src/types.ts`) and set it in `createContext` to `join(dirname(config.dbPath), "routing.json")`. In `agents.ts`, add `withRoutedModel(input, presetId, routingFile)` and call it in `buildTerminalAgentLaunch`; pass `ctx.launchRoutingFile` from `runTerminalAgent` and from `workspaces.ts`.


## Concrete Steps

From the repository root:

    bun test packages/shared/src/agent-launch-estimator.test.ts
    (cd packages/host-service && bun test src/trpc/router/agents/ src/trpc/router/workspaces/ src/trpc/router/workspace-creation/)
    (cd packages/shared && bun run typecheck) && (cd packages/host-service && bun run typecheck)

On the VPS, after building and installing the fork (roadmap section 10 and its Decision Log entry of 2026-10-21):

    ln -sf ~/.local/share/ade/router/routing.json ~/.superset/host/<organization id>/routing.json


## Validation and Acceptance

The roadmap's acceptance, on the VPS host:

    superset agents create --local --workspace <W> --agent claude --prompt "fix typo in README"
    # terminal header: Haiku … with low effort; host log: [routing] model=haiku effort=low reason=rule … -> S
    superset agents create --local --workspace <W> --agent claude --model opus --prompt "fix typo in README"
    # Opus: an explicit model wins
    superset agents create --local --workspace <W> --agent claude --resume-session <id>
    # no [routing] line: a resume keeps its session's model


## Idempotence and Recovery

Removing the link `~/.superset/host/<organization id>/routing.json` turns routing off at the next launch; no restart is needed.


## Artifacts and Notes

Acceptance on the VPS, 2026-10-21 22:35 local, workspace `m1-check` of the toy project, `~/.superset/host/<org>/routing.json -> ~/.local/share/ade/router/routing.json`:

    agents create --agent claude --prompt "fix typo in README: … reply OK"
        header: Haiku 5.5 with low effort
        host log: [routing] model=haiku effort=low reason=rule /typo|rename|bump|lint|format|readme|changelog/ -> S
    agents create --agent claude --model opus --prompt "fix typo in README: … reply OK"
        header: Opus 5.5            (no [routing] line)
    agents create --agent claude --resume-session <first session> --prompt "…"
        header: Haiku 5.5           (no [routing] line: one line in total for the three launches)


## Interfaces and Dependencies

    // packages/shared/src/agent-launch-estimator.ts
    export type LaunchRules = { tiers: Record<string, Choice>; roles: Record<string, Choice>; rules: { match: RegExp; tier: string }[]; fallbackTier: string | null };
    export type LaunchEstimate = { model: string; effort: Effort; reason: string };
    export function parseLaunchRules(text: string): LaunchRules;
    export function estimateAgentLaunch(input: { presetId: string; prompt: string; size?: string; role?: string }, rules: LaunchRules): LaunchEstimate | null;

    // packages/host-service/src/trpc/router/agents/agents.ts
    export function buildTerminalAgentLaunch(db: HostDb, input: AgentRunInput, options?: { routingFile?: string }): { fullCommand: string; label: string };


## Revision notes

2026-10-21: recorded the VPS acceptance and moved the plan to `plans/done/`.
