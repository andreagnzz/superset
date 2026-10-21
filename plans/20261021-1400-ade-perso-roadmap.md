# ADE perso sur Superset : routeur de modèle, plan → issues → run, PR empilées, review en boucle

Feuille de route pour ton fork de **superset-sh/superset** (l'ADE, pas Apache Superset). Code vérifié le 21/10/2026 sur `superset-sh/superset@910ccfe` (version 1.39.0). Les agents tournent sur le VPS (`andrea@claude-vps`), le pilotage se fait depuis l'app desktop sur le Mac.

**Mode d'emploi.** Mets ce fichier dans `plans/` de ton fork. Pour chaque milestone, demande d'abord à Claude (Opus, effort `xhigh`) l'ExecPlan détaillé au format de `.agents/commands/create-plan.md`, valide-le, puis fais-le implémenter sur sa propre branche, une PR par milestone. Prompt de départ :

    Lis plans/20261021-1400-ade-perso-roadmap.md. On attaque <milestone>.
    Rédige l'ExecPlan complet selon .agents/commands/create-plan.md
    (lis AGENTS.md, packages/host-service/AGENTS.md et packages/trpc/AGENTS.md avant),
    attends mon OK, puis implémente sur une branche dédiée et ouvre une PR.

## 1. Objectif

Quand ce plan est fini, tu peux :

1. Décrire une feature. Un agent planificateur écrit le plan, le découpe en issues avec dépendances et taille estimée, et redécoupe les grosses issues.
2. Cliquer sur Run en choisissant le nombre max d'agents en parallèle. Chaque issue part dans son propre workspace avec le modèle et l'effort tirés de tes règles, et ses subagents suivent les mêmes règles.
3. Récupérer une pile de PR (chaque branche part de la précédente), chacune relue par un reviewer à contexte neuf, en boucle jusqu'à approbation ou jusqu'au nombre max de tours.
4. Fermer le Mac : tout continue sur le VPS.

## 2. Topologie

    Mac : app desktop Superset                        VPS andrea@claude-vps (Linux, 16 Go)
      UI : plan, Run, suivi des runs  ── relay ──►   host-service : API tRPC, SQLite host.db, file d'attente
      (Remote Access = plan Pro)                      ├─ pty-daemon → Claude Code dans chaque worktree
                                                      ├─ ~/.claude : hooks Superset + ton plugin (mod routeur, skills)
                                                      └─ git worktrees, gh (PR)

Règles de placement :

- Tout ce qui doit tourner Mac fermé (file d'attente, routage, restack, boucle de review) va dans le **host-service** (`packages/host-service`), sur le VPS.
- L'app desktop (`apps/desktop`, sur le Mac) affiche et déclenche, rien de plus.
- L'API cloud (`apps/api`, `packages/trpc`, api.superset.sh) n'est pas modifiable par un fork. Tout nouvel état va dans la base SQLite du host : `packages/host-service/src/db/schema.ts`, migration dans `packages/host-service/drizzle/`.

## 3. Ce qui existe déjà (ne pas le reconstruire)

| Besoin | Déjà dans Superset | Où |
|---|---|---|
| Modèle et effort à chaque lancement | `--model` (fable, opus, sonnet, haiku, ids figés) et `--effort` (low, medium, high, xhigh, max) | `AGENT_MODEL_SUPPORT`, `AGENT_EFFORT_SUPPORT` dans `packages/shared/src/agent-models.ts` ; `superset agents create --model --effort` |
| Point de passage unique des lancements | desktop, CLI, mobile, SDK, MCP et automations passent tous par le host | `buildTerminalAgentLaunch` et `runAgentInWorkspace` dans `packages/host-service/src/trpc/router/agents/agents.ts` |
| Issues | tâches Superset (cloud), liées à un workspace | `superset tasks create` ; `workspaces.create` accepte `taskId` |
| Lancer des issues | « Run in workspace » : lance tout d'un coup, sans dépendances ni limite | `RunInWorkspacePopoverV2` (`Promise.all`) |
| Orchestration | skill coordinateur : graphe dans le contexte de l'agent, enveloppes `SUPERSET_WORKER_DONE` / `SUPERSET_WORKER_BLOCKED` | `plugins/superset/skills/orchestrate/SKILL.md` |
| Savoir où en est un agent | hooks Claude → `notifications.hook` → `terminalAgentStore` ; états starting / working / blocked / idle | `packages/shared/src/agent-status.ts` ; `superset agents wait --until settled` |
| Écrire à un agent en cours | `sendAgentMessage` ; `superset terminals send --wait` | `packages/host-service/src/terminal/terminal.ts` |
| Empiler des branches | `superset workspaces create --base-branch <parente>` écrit `branch.<nom>.base`, que la création de PR prend comme base | `workspaces.ts` ; `createForWorkspace` |
| Boucle d'arrière-plan qui pilote des agents | modèle à copier | `PageWatchManager` dans `packages/host-service/src/page-watch/page-watch-manager.ts` |
| Format de plan | ExecPlan : template et cycle de vie | `.agents/commands/create-plan.md` |

Ce qui manque : l'estimateur, les dépendances entre issues, la limite d'agents en parallèle, le restack (rebase, push forcé, changement de base après merge), la boucle de review, et l'application des règles aux subagents.

## 4. Décisions

- **D1. Logique dans le host-service (VPS), UI dans le desktop (Mac).** Le host-service est la seule couche que tu contrôles qui tourne Mac fermé.
- **D2. Pas de changement de l'API cloud.** Les issues restent des tâches Superset (visibles dans l'app). Le graphe de dépendances et l'état des runs vivent dans `host.db`.
- **D3. Prototype sans fork d'abord (Phase 1), puis durcissement dans le fork (Phases 2 et 3).** Tu règles tes règles et ton workflow en quelques jours, et le fork ne reçoit que du code déjà validé. Upstream sort une version environ tous les cinq jours (1.37 le 9/10, 1.38 le 14/10, 1.39 le 19/10) et reçoit 15 à 50 commits par jour : moins tu touches aux fichiers existants, moins tu as de conflits.
- **D4. Le planificateur estime chaque issue (taille S, M, L ou XL).** L'estimateur automatique ne sert qu'aux lancements sans estimation (à la main, automations). L'agent qui a écrit le plan est celui qui a le plus de contexte.
- **D5. Subagents : le modèle passe par un mod Claude Code.** Un hook `agent.spawn` appelle `next({ ...e, model })`, qui remplace le modèle que Claude passe à l'appel (renvoyer `{ model }` sans `next` ne démarre aucun subagent). L'effort passe par le paramètre `effort` de l'appel Agent (Claude Code ≥ 2.1.292), réécrit par un hook. Ne jamais définir `CLAUDE_CODE_EFFORT_LEVEL` : il écrase tous les autres réglages d'effort, y compris les tiens.
- **D6. L'approbation de review est suivie dans `host.db`, pas sur GitHub.** GitHub refuse qu'un compte approuve sa propre PR.

## 5. Règles de routage (`routing.json`)

Un seul fichier, lu par le mod (subagents) et par le host-service (lancements). Grille par défaut, à remplacer par les règles de ton pote :

```json
{
  "version": 1,
  "tiers": {
    "S":  { "model": "haiku",  "effort": "low" },
    "M":  { "model": "sonnet", "effort": "high" },
    "L":  { "model": "opus",   "effort": "high" },
    "XL": { "model": "opus",   "effort": "xhigh" }
  },
  "roles": {
    "plan":    { "model": "opus",  "effort": "xhigh" },
    "review":  { "model": "opus",  "effort": "high" },
    "explore": { "model": "haiku", "effort": "low" }
  },
  "subagents": { "Explore": "explore", "Plan": "plan", "*": "rules-or-parent" },
  "rules": [
    { "match": "typo|rename|bump|lint|format|readme|changelog", "tier": "S" },
    { "match": "migration|concurren|race condition|security|auth|architecture|refonte", "tier": "XL" }
  ],
  "fallbackTier": "M",
  "escalation": { "afterFailures": 1, "maxTier": "XL" }
}
```

Lecture :

- Lancement d'un agent : la taille donnée par le plan gagne ; sinon la première règle dont `match` trouve le prompt ; sinon `fallbackTier`.
- Subagent : son type d'abord (`Explore`, `Plan`) ; sinon `rules-or-parent` = les mêmes règles appliquées à son prompt, et à défaut le modèle de la session parente.
- Après un échec ou un blocage, on relance une taille au-dessus, jusqu'à `maxTier`.
- `fable` reste hors grille : à réserver à l'escalade sur les problèmes les plus durs, selon ton budget.

## 6. Phase 0 : mise en place

1. Forker `superset-sh/superset` (le fork actuel est Apache Superset, à supprimer), puis `git remote add upstream https://github.com/superset-sh/superset`.
2. Mac : installer l'app officielle et se connecter. Piloter un host distant passe par le relay, c'est la fonctionnalité Remote Access du plan **Pro** (20 $/mois, ou 15 $/mois en annuel). Sans Pro : tout reste faisable en CLI sur le VPS, par SSH.
3. VPS, avant d'ajouter le host :
   - `cat /etc/machine-id` doit donner une valeur propre à cette machine. Une image clonée donne le même id de host, et deux hosts au même id se volent le tunnel. Sinon : `sudo rm /etc/machine-id && sudo systemd-machine-id-setup`.
   - `gh auth login`, sinon les repos privés ne se clonent pas.
   - Monter les limites inotify (`fs.inotify.max_user_instances`, 128 par défaut) : Superset surveille chaque worktree.
4. Depuis le Mac : `superset hosts add andrea@claude-vps` (passe par ton SSH Tailscale). La commande installe la CLI officielle, la connecte à ton compte et crée un service systemd utilisateur (`~/.config/systemd/user/superset-host.service`). Accepte le « linger » pour que le host tourne après ta déconnexion.
5. Permissions : le preset `claude` se lance avec `--dangerously-skip-permissions` (`packages/shared/src/builtin-terminal-agents.ts`). Sur un VPS qui héberge aussi ton hub CodeTgh, choisis en connaissance de cause. Les arguments de l'agent se changent dans ses réglages sur le host (procédure `settings.agentConfigs.update`), sans code. Sans bypass, des agents passeront en état `blocked` en attendant une validation, et la file d'attente devra le gérer.
6. Une fois le fork installé, ne jamais lancer `superset update`, `superset start --auto-update` ni cliquer « Update host » dans l'app : ces trois chemins téléchargent la version officielle (`ROLLING_DOWNLOAD_BASE` dans `packages/cli/src/commands/update/command.ts`) et écrasent ton fork.

**Acceptance.** Le VPS apparaît dans Settings → Hosts de l'app Mac. Créer un workspace sur le VPS et y lancer Claude fonctionne. `superset status` sur le VPS montre le host en ligne.

## 7. Phase 1 : plugin perso, sans fork (quelques jours)

Un plugin Claude Code installé sur le VPS, dans ton repo de config `claude-setup` transformé en marketplace ou dans un repo dédié. Il marche avec le Superset officiel.

### P1.1 Spike (une demi-journée) : vérifier les hypothèses risquées

Sur le VPS, avec Claude Code ≥ 2.1.292 :

- **(a)** Un mod avec `on('agent.spawn', …)` qui appelle `next({ ...e, model: 'haiku' })` fait bien tourner le subagent sur Haiku (vérifier dans le transcript). Les champs de l'événement sont dans les types générés : lancer `claude --plugin-dir ./router`, puis lire `.claude-plugin/types/claude-code/index.d.ts` dans le dossier du mod.
- **(b)** L'effort d'un subagent se change en réécrivant l'appel `Agent` : soit un hook `tool.call` du mod (`next({ ...e, effort })` : les arguments de l'outil sont à plat sur `e`), soit un hook `PreToolUse` (matcher `Agent`) qui renvoie `hookSpecificOutput.updatedInput`. Dans ce second cas, renvoyer l'entrée complète, pas seulement le champ changé.
- **(c)** `claude --dangerously-skip-permissions --permission-mode plan` : noter quel flag gagne. Ça décide si un mode « Plan » peut réutiliser le preset `claude` (voir M0).

Noter les résultats dans le Decision Log. Si (a) ou (b) échoue, repli : `CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (Claude Code ≥ 2.1.257), qui impose un seul modèle à tous les subagents.

### P1.2 Mod `router` : l'estimateur des subagents

- `routing.json` (section 5) dans le plugin.
- `agent.spawn` : type du subagent → rôle ; sinon les règles sur son prompt ; sinon le modèle du parent. Passe `{ ...e, model }` à `next`.
- Effort : hook `tool.call` sur `Agent`, `next({ ...e, effort })` (validé par le spike (b)).
- Chargé dans toutes les sessions Claude du VPS : installation utilisateur du plugin, ou `CLAUDE_CODE_PLUGIN_DIRS` dans la clé `env` de `~/.claude/settings.json`.
- Tests : `claude plugin test`, un cas par règle.

### P1.3 Skill `/plan` : ton mode plan

- Session Opus `xhigh`, consigne stricte : explorer, n'écrire que dans `plans/`.
- Sortie 1 : `plans/<YYYYMMDD-HHmm>-<nom>.md`, au format de `.agents/commands/create-plan.md`.
- Sortie 2 : `plans/<YYYYMMDD-HHmm>-<nom>.issues.json`, une liste d'issues `{ key, title, prompt, size, dependsOn, stackOn, files, acceptance, verify }` (`size` = S, M, L ou XL ; `dependsOn` = clés ; `stackOn` = clé ou null ; `verify` = commandes).
- Découpe : une issue = une PR vérifiable seule. Toute issue XL, ou qui touche plusieurs zones indépendantes, est redécoupée. `stackOn` quand une issue a besoin du code d'une autre ; sinon l'issue part de la branche principale, en parallèle.
- Contrôles automatiques : pas de cycle, chaque `dependsOn` existe, chaque issue a au moins une commande dans `verify`.
- Optionnel : une tâche Superset par issue (`superset tasks create`), pour les voir dans l'app.

### P1.4 Skill `/run-plan <issues.json> --max-parallel N`

Coordinateur qui suit le protocole de `superset:orchestrate` :

- Boucle : tant que moins de N agents travaillent, prendre une issue prête (toutes ses dépendances finies).
- Workspace : `superset workspaces create --host <vps> --project <id> --branch <feat/...> [--base-branch <branche de stackOn>] --tag <run>`. Pousser la branche parente juste avant : quand elle a un upstream, l'enfant part de `origin/<parente>`.
- Agent : `superset agents create --workspace <id> --host <vps> --agent claude --model <tier.model> --effort <tier.effort> --prompt "<prompt de l'issue + enveloppe SUPERSET_WORKER_DONE>"`.
- Attente : `superset agents wait --until settled`, puis lire l'enveloppe avec `superset terminals read`.
- Issue finie : push, `gh pr create --base <branche parente ou main>`, puis `/review-pr`.
- Échec ou blocage : une relance, une taille au-dessus.

Limite connue : l'état du run vit dans le contexte du coordinateur. S'il meurt, le run est perdu. La Phase 2 corrige ça.

### P1.5 Skill `/review-pr <workspace> <pr>`

- Reviewer à contexte neuf : nouvelle session dans le même workspace (`superset agents create` sans `--resume-session`, `--fork-session` ni `--from-terminal`), rôle `review` de la grille.
- Consigne : ne rien modifier ; écrire `.superset-review/verdict.json` = `{ "approve": bool, "findings": [{ "file", "line", "severity", "fix" }] }`.
- Refus : envoyer les findings à l'agent implémenteur (`superset terminals send --wait`), puis nouveau reviewer neuf. Trois tours maximum.
- Fermer le terminal du reviewer à chaque tour (`superset terminals close`).

**Acceptance Phase 1.** Sur un repo jouet, un plan de 4 issues (dont 2 empilées) lancé avec `--max-parallel 2` : jamais plus de 2 agents actifs (`superset snapshot`), des PR avec les bonnes bases, et chaque PR passe au moins une review neuve.

## 8. Phase 2 : fork, host-service sur le VPS

Contraintes de chaque PR :

- API tRPC uniquement additive : `packages/trpc/AGENTS.md`, `packages/host-service/AGENTS.md`, `.agents/skills/trpc-compat/SKILL.md`. Un client qui appelle une nouvelle procédure gère un host qui ne l'a pas.
- Aucun appel git sur la boucle principale (`packages/host-service/src/no-main-loop-blocking.test.ts`).
- Tests rapides, sans vraie attente (section Tests de `AGENTS.md`).

### M0 : mode « Plan » pour Claude (petite PR)

Ajouter une entrée `claude` à `AGENT_MODE_SUPPORT` (`packages/shared/src/agent-models.ts`) avec `args: ["--permission-mode", "plan"]`, si le spike (c) montre que ça marche avec le preset. Le sélecteur de mode existant affiche alors l'option, sans nouvelle UI.

### M1 : estimateur au lancement

- Nouveau module pur `packages/shared/src/agent-launch-estimator.ts` : `estimateAgentLaunch({ presetId, prompt, size?, role? }, rules)` renvoie `{ model, effort, reason }` ou `null`. Tests à côté.
- Appel dans `buildTerminalAgentLaunch` (`agents.ts`), juste après `resolveAgentLaunchPresetId`, seulement si `!input.model && !input.effort && !input.resumeSessionId && !input.forkSessionId`. Le résultat passe ensuite par les validateurs existants (`validateAgentModelSelection`, `validateAgentEffortSelection`).
- Ne pas l'appeler en haut de `runAgentInWorkspace` : `continuationConfig` et `chatLaunchTarget` refusent une entrée qui porte un modèle ou un effort, ça casserait les continuations d'automations et le chat.
- Activation : chemin du fichier de règles dans une nouvelle colonne de `hostSettings` (avec migration). Vide = désactivé.
- Journal : une ligne `[routing] model=… effort=… reason=…` dans `host-service.log`.
- Plus tard : la même logique côté chat, dans `packages/host-service/src/trpc/router/sessions/create-chat-session.ts`.

**Acceptance.** `superset agents create … --agent claude --prompt "fix typo in README"` lance `--model haiku --effort low`. Avec `--model opus` explicite, rien ne change. Une reprise (`--resume-session`) ne change rien.

### M2 : plans et issues dans `host.db`

- Tables dans `packages/host-service/src/db/schema.ts`, migration dans `packages/host-service/drizzle/` :
  - `plan_runs` : `id, projectId, name, maxParallel, status, createdAt`
  - `plan_issues` : `id, runId, key, title, prompt, size, dependsOn (JSON), stackOn, taskId, branch, workspaceId, terminalId, status, attempts, prUrl`, avec `status` = queued, ready, running, review, done, failed ou blocked.
- Routeur `planRuns` (`import`, `list`, `get`, `start`, `cancel`, `setMaxParallel`), enregistré dans `packages/host-service/src/trpc/router/router.ts`.
- CLI : `superset plan import <issues.json> --project <id>`, `superset plan run <id> --max-parallel N`, `superset plan status <id>`, dans un nouveau groupe sous `packages/cli/src/commands/`.

### M3 : file d'attente (dépendances + max agents)

- Gestionnaire `packages/host-service/src/runtime/plan-runs/`, construit dans `createApp` (`packages/host-service/src/app.ts`) à côté de `PullRequestRuntimeManager`, et ajouté à l'objet `runtime`.
- Il réévalue la file à chaque événement d'agent (`fanOutAgentLifecycle`, changements du `terminalAgentStore`), à la sortie d'un terminal, sur un intervalle, et au démarrage après `resumeCrashedAgentSessions`.
- Lancement : `createWorkspacesCaller(ctx).create({ projectId, taskId, agents, tags })` en interne, avec modèle et effort tirés de la taille par l'estimateur (M1).
- Fin d'une issue : événement `Stop` **et** enveloppe `SUPERSET_WORKER_DONE` lue dans le transcript (`readHarnessTranscriptOffLoop`). Un `Stop` seul veut dire « fin de tour », pas « tâche finie ».
- Limite par défaut : 3 agents en parallèle (16 Go partagés avec le hub CodeTgh). Ajuster en lisant les lignes `[host-service:vitals]` de `host-service.log`.

**Acceptance.** Plan de 5 issues dont une dépendante, `--max-parallel 2` : jamais plus de 2 agents actifs ; l'issue dépendante démarre après sa parente ; tuer le host-service en plein run puis le relancer reprend la file là où elle était.

### M4 : PR empilées et restack

- Création : pousser la branche parente (`gitPushTask`), puis créer le workspace enfant avec `baseBranch` = branche parente. Ça écrit `branch.<enfant>.base`, que `createForWorkspace` prend comme base de PR.
- Restack : nouvelles tâches worker dans `packages/host-service/src/workers/tasks/git.ts` via `defineWorkerTask`, pour `rebase --onto` et `push --force-with-lease`. Le code actuel ne force jamais un push.
- Après le merge d'une PR du bas : changer la base de la suivante avec `octokit.pulls.update({ base })`. Aujourd'hui, `pulls.update` ne sert qu'à rouvrir une PR (`packages/host-service/src/trpc/router/github/github.ts`).
- Gestionnaire `packages/host-service/src/runtime/stacks/`, déclenché par les changements de `headSha` que suit déjà `PullRequestRuntimeManager`.

**Acceptance.** Pile de 3 PR : modifier la PR du bas déclenche le rebase des deux autres ; merger la PR du bas repointe la suivante sur `main`.

### M5 : boucle de review à contexte neuf

- Gestionnaire `packages/host-service/src/runtime/review-loop/`, sur le modèle de `PageWatchManager` (tick, `sendAgentMessage`, `agentIsBusy`, `isTerminalAlive`).
- Chaque tour : reviewer neuf via `runAgentInWorkspace` sans `continueTerminalId`, sans reprise ni fork ; attendre `Stop` ; lire `.superset-review/verdict.json` ; poster les findings (`pullRequests.addComment`) ; les envoyer à l'implémenteur (`sendAgentMessage`) ; fermer le terminal du reviewer.
- État (tours, verdicts, approbation) dans `host.db`. Nombre max de tours réglable, 3 par défaut.

**Acceptance.** Une PR avec un bug volontaire est refusée au tour 1, corrigée, puis approuvée au tour 2. Une PR qui ne converge pas s'arrête au tour 3 avec le statut `blocked`.

### M6 : règles des subagents livrées par le host (optionnel)

Injecter le mod `router` dans chaque Claude lancé par Superset : `CLAUDE_CODE_PLUGIN_DIRS` dans l'env construit par `agentLaunchEnv` (`packages/host-service/src/terminal-agents/agent-config.ts`). Inutile si l'installation utilisateur de la Phase 1 te suffit.

## 9. Phase 3 : fork, app desktop sur le Mac

- **Vue Plan** : arbre d'issues avec dépendances et tailles, bouton « Découper » (renvoie l'issue au planificateur), bouton Run avec un champ « Max agents ». Partir des vues de `apps/desktop/src/renderer/routes/_authenticated/_dashboard/tasks/` et remplacer, dans `RunInWorkspacePopoverV2`, le `Promise.all` par un appel à `planRuns.start`.
- **Vue Run** : état de chaque issue (en file, en cours, en review, finie), pile de PR, tours de review.
- Nouvelles procédures appelées avec un repli si le host ne les a pas (`apps/desktop/src/renderer/lib/isMissingProcedureError.ts`).
- Textes via Lingui, puis `bun run check:i18n` (la CI l'impose).
- Build : `bun run build` sur le Mac ; l'app sort dans `apps/desktop/release`.
- Ne pas toucher au paywall (`apps/desktop/src/renderer/components/Paywall/`) : la licence Elastic 2.0 interdit de contourner les fonctions protégées par licence.

## 10. Installer et maintenir le fork sur le VPS

- Build Linux : `packages/cli/scripts/build-dist-linux-docker.sh`, ou à la main avec Bun 1.4.3, Node 22, python3, make et g++ :

      bun install --frozen --ignore-scripts
      (cd node_modules/.bun/node-pty@*/node_modules/node-pty && npx --yes node-gyp rebuild)
      npm rebuild @parcel/watcher
      cd packages/cli && bun run build:dist --target=linux-x64

  Sortie : `packages/cli/dist/superset-linux-x64.tar.gz` (`bin/superset`, `bin/superset-host`, `lib/…`, `share/migrations`).
- Remplacer l'installation qu'utilise le service systemd (chemin dans `~/.config/systemd/user/superset-host.service`), puis `systemctl --user restart superset-host`.
- Garder le numéro de version égal à celui d'upstream (1.39.0 aujourd'hui) : l'app Mac voit alors le host « à jour » et ne propose pas de le mettre à jour.
- Synchroniser upstream chaque semaine (`git fetch upstream && git rebase upstream/main`). Le nouveau code va dans de nouveaux modules ; dans les fichiers existants, se limiter à quelques lignes d'appel.
- Licence : garder les mentions existantes et indiquer clairement dans le README du fork qu'il s'agit d'une version modifiée (Elastic 2.0).

## 11. Risques et points ouverts

- L'API des mods de Claude Code est récente et la doc prévient que ses événements peuvent changer d'une version à l'autre. Une fois le spike validé, figer la version de Claude Code sur le VPS et relancer `claude plugin test` après chaque mise à jour.
- 16 Go partagés : la charge vient surtout des stacks de dev que les agents démarrent dans leurs worktrees, plus que de Claude Code lui-même.
- Quota : Opus en `xhigh` partout le consomme vite. La grille de routage sert justement à garder Opus pour ce qui le mérite.
- Règles de ton pote : à mettre dans `routing.json` avant M1.

## Progress

- [x] Phase 0 : bon fork, host VPS ajouté, choix des permissions, mises à jour automatiques coupées (21/10/2026, sans Pro : host piloté en CLI sur le VPS)
- [x] P1.1 spike (a), (b), (c) (21/10/2026, `plans/done/20261021-2020-phase0-host-setup-p1-1-spike.md`)
- [x] P1.2 mod `router` (21/10/2026, `ade/router/`, déployé sur le VPS ; `plans/done/20261021-2139-p1-2-router-mod.md`)
- [x] P1.3 `/plan` (21/10/2026, `/ade:plan`)
- [x] P1.4 `/run-plan` (21/10/2026, `/ade:run-plan` ; recette Phase 1 passée)
- [x] P1.5 `/review-pr` (21/10/2026, `/ade:review-pr` ; boucle vérifiée sur un bug planté)
- [ ] M0 mode Plan
- [x] M1 estimateur (21/10/2026, activé par `routing.json` à côté de `host.db`, sans migration)
- [x] M2 plans et issues (21/10/2026, fichiers JSON à côté de `host.db`, pas de tables)
- [x] M3 file d'attente (21/10/2026, `superset plan import/run/status/list/cancel`)
- [ ] M4 PR empilées et restack
- [ ] M5 boucle de review
- [ ] M6 mod injecté par le host (inutile pour l'instant : `CLAUDE_CODE_PLUGIN_DIRS` dans `~/.claude/settings.json` charge déjà le mod dans toutes les sessions Claude du VPS)
- [ ] Phase 3 vues Plan et Run

## Decision Log

Décisions D1 à D6 en section 4. Ajouter ici les résultats du spike P1.1 et chaque changement de cap, avec la date et la raison.

Preuves détaillées (sorties de chaque cas) : `plans/done/20261021-2020-phase0-host-setup-p1-1-spike.md`, section « Artifacts and Notes ». Mod et script du spike : `plans/spikes/20261021-p1-1-router-spike/`.

- **21/10/2026 — Spike (a) validé.** Sur Claude Code 2.1.305, `on('agent.spawn', …)` + `next({ ...e, model: 'haiku' })` fait tourner le subagent sur `claude-haiku-5-5` même quand le parent demande `model: "sonnet"` (vu dans `requestedModel` du transcript du subagent). Le repli `CLAUDE_CODE_SUBAGENT_MODEL` est inutile.
- **21/10/2026 — Spike (b) validé.** `on('tool.call', { tool: 'Agent' }, …)` + `next({ ...e, effort: 'low' })` passe l'effort du subagent de `medium` à `low`. Même résultat avec tous tes plugins utilisateur chargés. Les voies `turn.step` et `PreToolUse` n'ont pas été nécessaires.
- **21/10/2026 — Spike (c) : `--dangerously-skip-permissions` gagne toujours** sur `--permission-mode plan`, dans les deux ordres, en `-p` comme en interactif. Avec `--allow-dangerously-skip-permissions --permission-mode plan`, c'est le mode plan qui gagne, et le bypass reste accessible par Shift+Tab. Quand `--permission-mode` apparaît deux fois, le dernier gagne. Conséquence pour M0 : ajouter `--permission-mode plan` au preset actuel ne marche pas ; M0 doit d'abord changer la façon dont le preset donne le bypass (par exemple `--allow-dangerously-skip-permissions --permission-mode bypassPermissions`).
- **21/10/2026 — Pas de plan Pro.** Phase 0 se fait sur le VPS seul : CLI installée et connectée sur le VPS, pilotage en CLI par SSH. On ne reconstruit pas et on ne contourne pas Remote Access dans le fork : c'est une fonction payante (`GATED_FEATURES.REMOTE_ACCESS`), et la licence Elastic 2.0 l'interdit. Les phases 1 et 2 n'en ont pas besoin. La phase 3 (l'app Mac qui pilote le VPS) en a besoin : à rediscuter avant de la commencer.
- **21/10/2026 — Permissions : bypass gardé** pour le preset `claude` (Phase 0 étape 5). Réversible dans les réglages d'agent du host.
- **21/10/2026 — Le VPS a 11 Go de RAM, pas 16.** À prendre en compte pour la limite par défaut de M3.
- **21/10/2026 — Fork déjà en place** : `origin` = `andreagnzz/superset` (même HEAD qu'upstream), `upstream` = `superset-sh/superset`.
- **21/10/2026 — Host installé sans Pro.** CLI 1.39.0 dans `~/superset` (script officiel), connexion par `superset auth login` (mode « coller le code »), service `~/.config/systemd/user/superset-host.service` écrit à la main à l'identique de ce que fait `superset hosts add`, activé, avec le linger. Projet jouet `ade-sandbox` (`~/code/ade-sandbox`, sans remote pour l'instant) : un workspace et un agent Claude y ont tourné. Reboot pas testé.
- **21/10/2026 — `superset status` ment sur un host installé par la CLI** (bug upstream de `looksLikeHostProcess`, `packages/cli/src/lib/host/process-identity.ts` : il cherche `superset-host` dans la ligne de commande, mais le wrapper fait `exec node host-service.js`). Pour vérifier le host, utiliser `superset hosts list`. Ne pas lancer `superset start` à la main à côté du service : il risque de démarrer un second host. Corrigé dans le fork : PR andreagnzz/superset#2 (effectif sur le VPS seulement quand le build du fork remplacera l'officiel, Phase 2).
- **21/10/2026 — Fenêtre de confiance de Claude Code : approuver chaque projet une fois.** Un worktree hérite la confiance du dépôt principal du projet. Si le dépôt principal n'a jamais été approuvé, chaque nouveau worktree bloque Claude sur « Is this a project you created or one you trust? », même avec `--dangerously-skip-permissions`. Superset ne pré-approuve volontairement jamais un dossier qui contient déjà du code (`seed-agent-trust.ts`). Règle pour P1.4 et M3 : avant le premier run sur un projet, vérifier que `projects["<chemin du dépôt principal>"].hasTrustDialogAccepted` vaut `true` dans `~/.claude.json`, sinon ouvrir `claude` une fois dans ce dossier et accepter. Vérifié le 21/10 : une fois `~/code/ade-sandbox` approuvé, un nouveau workspace a démarré sans la fenêtre.
- **21/10/2026 — Sur un host neuf, lancer `superset agents list --local` une fois** avant `workspaces create --agent claude`, sinon « No host agent config matching 'claude' ». Déjà fait sur le VPS. Corrigé dans le fork : PR andreagnzz/superset#3.
- **21/10/2026 — P1.2 : mod `router` en place.** Le code vit dans le fork, `ade/router/` (M6 l'injectera depuis le host). Copie déployée dans `~/.local/share/ade/router`, chargée par `CLAUDE_CODE_PLUGIN_DIRS` dans la clé `env` de `~/.claude/settings.json` : toutes les sessions Claude du VPS l'ont, y compris celles que lance Superset. Pour changer la grille : modifier `ade/router/routing.json`, puis `rsync -a --delete --exclude='*.test.ts' --exclude='.claude-plugin/types' --exclude='.gitignore' ade/router/ ~/.local/share/ade/router/`. Retour arrière : retirer `CLAUDE_CODE_PLUGIN_DIRS` de `~/.claude/settings.json`. Vérifié sur de vrais subagents : `Explore` → haiku/low, tâche « typo » → haiku/low, tâche neutre → modèle du parent. Un `routing.json` invalide ne route rien et ne bloque jamais un subagent.
- **21/10/2026 — Le fork tourne sur le VPS** (`main` @ `edb62c5`, version 1.39.0, avec #2 et #3). Build fait dans Docker avec les mêmes étapes que `packages/cli/scripts/build-dist-linux-docker.sh` (smoke test et E2E headless passés), mais avec un dossier `/out` monté : le script tel quel jette le tarball à la fin du conteneur. Installé dans `~/superset` ; l'officiel est gardé dans `~/superset-official-1.39.0`. Démarrage vérifié en redémarrant `user@1001.service` (le chemin du boot avec le linger) : host relancé seul, `superset status` = running/healthy, agent Claude lancé dans un workspace. Les sessions tmux tournent dans `cron.service` et n'ont pas été touchées. Pas de vrai reboot : il couperait les 7 sessions tmux. Retour à l'officiel : `systemctl --user stop superset-host && ~/superset/bin/superset stop --terminals && mv ~/superset ~/superset-fork && mv ~/superset-official-1.39.0 ~/superset && systemctl --user start superset-host`. À partir de maintenant, ne jamais lancer `superset update` ni `superset start --auto-update` (section 6).
- **21/10/2026 — Correctifs proposables upstream** : branches `fix/cli-status-host-wrapper` et `fix/host-seed-agent-configs-on-launch` du fork, un commit chacune posé sur `upstream/main`. La session n'a accès qu'au fork : ouvrir les PR depuis GitHub (compare vers `superset-sh/superset:main`), avec le texte des PR #2 et #3 du fork.
- **21/10/2026 — Phase 1 terminée.** Skills dans `ade/workflow/` (plugin `ade` : `/ade:plan`, `/ade:run-plan`, `/ade:review-pr`), avec `ade/workflow/scripts/ade.ts` pour tout ce qui est calcul (graphe, issues prêtes, tier avec escalade, verdict, agents actifs). Déployées à côté du router ; `CLAUDE_CODE_PLUGIN_DIRS` liste les deux dossiers. Repo jouet : `andreagnzz/ade-sandbox` (privé), projet Superset `ade-sandbox`. Recette (4 issues, C empilée sur A, D sur B, `--max-parallel 2`) : jamais plus de 2 agents actifs sur 90 relevés, bases de PR correctes, 4 PR approuvées par un reviewer neuf. Boucle de review vérifiée sur un bug planté : refus au tour 1, correction, approbation au tour 2. Détails : `plans/done/20261021-2158-p1-3-p1-5-plan-run-review-skills.md`.
- **21/10/2026 — Une issue n'empile que sur un parent.** Le planificateur chaîne donc les issues qui ont besoin du code de deux autres (plus de parallélisme). À traiter en M3/M4 (partir d'un merge des branches parentes).
- **21/10/2026 — M0 n'a pas d'effet avant la Phase 3.** Le mode se choisit dans l'app desktop, et la CLI n'a pas de `--mode` ; l'app sur le Mac est l'officielle, donc une entrée `claude` dans `AGENT_MODE_SUPPORT` du fork ne s'afficherait nulle part. M0 attend que le desktop soit construit depuis le fork, et devra changer le bypass du preset (spike (c)).
- **21/10/2026 — M1 en service.** Un lancement Claude sur le host du VPS sans `--model` ni `--effort` prend modèle et effort dans `~/.superset/host/<org>/routing.json`, qui est un lien vers `~/.local/share/ade/router/routing.json` (un seul fichier pour subagents et lancements). Retirer le lien coupe le routage, sans redémarrage. Pas de colonne dans `host_settings` : une migration host du fork entrerait en collision avec la numérotation d'upstream à chaque synchro. Recette : « fix typo in README » → Haiku/low avec la ligne `[routing]` ; `--model opus` → Opus ; une reprise → pas de routage. Fork recompilé et réinstallé (build précédent du fork gardé dans `~/superset-fork-prev`). Détails : `plans/done/20261021-2240-m1-launch-estimator.md`.
- **21/10/2026 — Pause avant M2 à M5 (décision D3), levée le même soir par le propriétaire (« go »).** La Phase 1 couvre déjà les objectifs 1 à 4 de la section 1, et le coordinateur tourne sur le VPS Mac fermé. M2 à M5 ajoutent la reprise après crash, le restack automatique et la review côté host, mais aussi beaucoup de code dans le host du fork. D3 dit de valider le workflow en Phase 1 pendant quelques jours avant de durcir le fork. Pour M2 : stocker l'état des runs hors de `host.db` (fichier JSON ou base séparée), pour la même raison que M1 (pas de migration host dans le fork).
- **21/10/2026 — M2 et M3 en service.** Le host exécute lui-même un `issues.json` : `superset plan import <fichier> --project <id> --local`, puis `superset plan run <id> --max-parallel N --local` ; `superset plan status <id> --local` donne l'état de chaque issue. L'état d'un run vit dans `~/.superset/host/<org>/plan-runs/<id>.json` (pas de tables dans `host.db`, même raison que M1). Recette : 5 issues dont une dépendante, `--max-parallel 2`, host redémarré en plein run → jamais plus de 2 agents actifs, C lancée après A et empilée dessus, reprise sans rien relancer deux fois, 5/5 terminées. Une issue se termine à `done` ; le push, la PR (M4) et la review (M5) viennent ensuite. Détails : `plans/done/20261021-2253-m2-m3-plan-runs.md`.
- **21/10/2026 — Remote `origin` en SSH** (`git@github.com:andreagnzz/superset.git`) : git n'a pas d'identifiants HTTPS sur le VPS, alors que la clé SSH de `gh` marche.

## Sources

- Superset : [Remote Access](https://docs.superset.sh/remote-access), [tarifs](https://superset.sh/pricing), [index de la doc](https://superset.sh/llms.txt)
- Claude Code : [modèle et effort](https://code.claude.com/docs/en/model-config.md), [subagents](https://code.claude.com/docs/en/sub-agents.md), [référence des mods](https://code.claude.com/docs/en/plugins/mods/reference.md), [hooks](https://code.claude.com/docs/en/hooks.md)
- Code : `superset-sh/superset@910ccfe`
