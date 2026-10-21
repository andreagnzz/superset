# Guide : planifier, lancer et faire relire du code avec des agents sur le VPS

Ce guide décrit ce qui tourne sur `claude-vps` après la roadmap `plans/20261021-1400-ade-perso-roadmap.md` (Phase 0 à M5), et comment s'en servir au quotidien. Tout se pilote en ligne de commande sur le VPS (SSH, ou une session Claude Code sur le VPS).

## Ce que ça fait

Tu décris une feature. Un agent Opus la découpe en issues (une issue = une PR), avec des dépendances et une taille. Le host Superset du VPS lance ensuite un agent par issue dans son propre workspace, jamais plus de N à la fois, ouvre une PR par issue, la fait relire par un reviewer neuf jusqu'à approbation, et garde les PR empilées à jour jusqu'à leur merge. Tout continue quand tu fermes ton terminal ou ton Mac.

    /ade:plan "feature"          → plans/<ts>-<nom>.md + plans/<ts>-<nom>.issues.json
    superset plan import …       → un run (pas encore lancé)
    superset plan run <id>       → le host prend la main :

      issue prête (dépendances finies, place libre)
        → workspace + agent (modèle et effort selon la taille)
        → l'agent commit et finit par SUPERSET_WORKER_DONE
        → push + PR (base = branche du parent si empilée, sinon main)
        → reviewer neuf → approuvé : done → les issues qui en dépendent démarrent
                        → refusé  : findings → l'implémenteur corrige → nouveau reviewer (3 tours max)
      après le run, tant que les PR sont ouvertes :
        parent modifié → enfants rebasés ; parent mergé → enfant repointé sur main et rebasé

À côté, le mod `router` choisit le modèle et l'effort de chaque subagent de toutes tes sessions Claude du VPS.

## Les pièces et où elles vivent

| Pièce | Rôle | Où |
|---|---|---|
| Host Superset (fork) | file d'attente des runs, PR, reviews, restack | `~/superset` (service `superset-host`), code dans `packages/host-service/src/runtime/plan-runs/` |
| CLI `superset plan` | importer, lancer, suivre un run | `packages/cli/src/commands/plan/` |
| Skills `/ade:plan`, `/ade:run-plan`, `/ade:review-pr` | planifier ; variante sans host du lancement et de la review | `ade/workflow/`, copie active dans `~/.local/share/ade/workflow` |
| Mod `router` | modèle et effort des subagents | `ade/router/`, copie active dans `~/.local/share/ade/router` |
| `routing.json` | la grille de règles, une seule pour tout | `~/.local/share/ade/router/routing.json` (le host le lit par le lien `~/.superset/host/<org>/routing.json`) |
| État des runs | un fichier JSON par run, verdicts des reviewers | `~/.superset/host/<org>/plan-runs/` |

Les deux plugins sont chargés par `CLAUDE_CODE_PLUGIN_DIRS` dans la clé `env` de `~/.claude/settings.json`.

## Préparer un projet (une fois par dépôt)

1. Le dépôt est cloné sur le VPS et a un remote GitHub où `gh` peut pousser.
2. C'est un projet Superset sur le host :

       superset projects list --local
       superset projects create --local --name <nom> --import ~/code/<repo>   # s'il n'y est pas

3. Claude fait confiance au dépôt principal (sinon chaque workspace bloque sur « Do you trust this folder? ») : ouvre `claude` une fois dans `~/code/<repo>` et accepte. Vérification :

       jq '.projects["/home/andrea/code/<repo>"].hasTrustDialogAccepted' ~/.claude.json   # true

4. Si le dépôt est un fork, fixe le dépôt cible de `gh`, sinon les PR partiraient vers l'original :

       (cd ~/code/<repo> && gh repo set-default <owner>/<repo>)

## Utilisation au quotidien

### 1. Planifier

Dans le dépôt :

    claude
    /ade:plan Ajouter l'export CSV des factures, avec tests

L'agent (Opus, effort `xhigh`) explore sans rien modifier, écrit `plans/<ts>-<nom>.md` (le plan) et `plans/<ts>-<nom>.issues.json` (les issues), puis vérifie le graphe. Relis les deux fichiers. Tu peux corriger `issues.json` à la main, puis revérifier :

    bun ~/.local/share/ade/workflow/scripts/ade.ts check plans/<ts>-<nom>.issues.json

Une issue : `key`, `title`, `prompt` (tout ce que l'agent doit savoir, il ne lira pas le plan), `size` (`S`, `M` ou `L` ; `XL` est refusé, il faut découper), `dependsOn`, `stackOn` (une clé de `dependsOn` si l'issue a besoin du code d'une autre, sinon `null`), `files`, `acceptance`, `verify` (commandes qui doivent passer).

### 2. Lancer (sur le host, durable)

    superset plan import plans/<ts>-<nom>.issues.json --project <id du projet> --local
    superset plan run <id du run> --max-parallel 3 --local

Le nom du run vient du nom du fichier (sans l'horodatage). Les branches sont `ade/<run>/<clé>`, les workspaces `<run>-<clé>`, tous tagués `<run>`. Si tu relances le même plan, donne un autre nom (`--name <nom>-2`), sinon les branches existent déjà.

Tu peux fermer le terminal : le host continue.

### 3. Suivre

    superset plan list --local
    superset plan status <id du run> --local
    journalctl --user -u superset-host -f | grep -E "plan-runs|routing"

Statuts d'une issue :

| Statut | Sens |
|---|---|
| `queued` | attend ses dépendances ou une place |
| `running` | l'implémenteur travaille (première passe ou correction après une review) |
| `review` | un reviewer neuf relit la PR |
| `done` | approuvée |
| `failed` | deux tentatives ratées (ou publication impossible) ; la colonne ERROR dit pourquoi |
| `blocked` | refusée 3 fois, pas de verdict valide en 3 tours, échec pendant une correction, ou une dépendance a échoué |

Chaque tour de review est commenté sur la PR (« ADE review, round N: … »). Les verdicts complets sont dans `~/.superset/host/<org>/plan-runs/<id du run>/<clé>-round<N>.json`. Pour regarder un agent : `superset workspaces list --local --tag <run>`, puis `superset terminals read --local --workspace <id> --terminal <id>`.

### 4. Merger

Merge les PR **du bas de la pile vers le haut**. Après chaque merge, le host repointe la PR suivante sur `main` et la rebase (en moins d'une minute). Si tu pousses toi-même un commit sur une PR qui a des enfants, ils sont rebasés automatiquement. Un rebase en conflit est commenté sur la PR (« ADE stack: … failed ») et l'issue n'est plus touchée : rebase-la à la main.

### 5. Arrêter, nettoyer

    superset plan cancel <id du run> --local        # ne démarre plus rien, arrête le restack de ce run ; les agents en cours finissent
    superset workspaces archive --local $(superset workspaces list --local --tag <run> --json | jq -r '.[].id')

### Variantes sans host

- `/ade:run-plan plans/<…>.issues.json --max-parallel 3` dans une session Claude : même logique, mais l'état vit dans cette session (si elle meurt, le run est perdu) et sans restack automatique.
- `/ade:review-pr <workspace> <pr> [terminal de l'implémenteur]` : la boucle de review sur une PR quelconque.

## Modèles et efforts

Une seule grille, `routing.json` :

- **Issue lancée par un run** : sa taille donne le tier (`S` haiku/low, `M` sonnet/high, `L` opus/high par défaut). Après un échec, un tier au-dessus (jusqu'à `escalation.maxTier`).
- **Reviewer** : le rôle `review` (opus/high).
- **Subagent** dans n'importe quelle session Claude du VPS : `Explore` → rôle `explore`, `Plan` → rôle `plan`, sinon la première règle dont le motif trouve le prompt, sinon le modèle du parent.
- **`superset agents create` sans `--model` ni `--effort`** : la première règle qui trouve le prompt, sinon `fallbackTier`. Un `--model` explicite et une reprise de session ne sont jamais touchés.

Pour changer la grille, modifie `ade/router/routing.json` dans le fork, puis :

    rsync -a --delete --exclude='*.test.ts' --exclude='.claude-plugin/types' --exclude='.gitignore' \
      ~/code/superset/ade/router/ ~/.local/share/ade/router/

Le prochain subagent et le prochain lancement l'utilisent, sans redémarrage. Un fichier invalide ne route plus rien mais ne bloque jamais un agent. Pour couper : retire le lien `~/.superset/host/<org>/routing.json` (lancements) ou `CLAUDE_CODE_PLUGIN_DIRS` de `~/.claude/settings.json` (subagents).

## Ce qu'il faut savoir

- **Ne lance jamais `superset update` ni `superset start --auto-update`** : ils remplacent ton fork par la version officielle.
- Pour vérifier le host : `superset hosts list` (ou `superset status`, qui est juste sur ce fork).
- Le host redémarre seul au boot (service systemd utilisateur + linger). Après un redémarrage, les runs reprennent où ils étaient.
- Une issue qui a besoin du code de deux autres oblige à les chaîner (une issue n'empile que sur un parent) : moins de parallélisme.
- Le plafond `--max-parallel` compte les implémenteurs et les reviewers. Avec 11 Go de RAM partagés avec tes autres services, 2 ou 3 est raisonnable.
- Les reviewers Opus coûtent du quota : un refus coûte un tour de plus, trois au maximum par issue.

## Mettre à jour le fork depuis upstream

    cd ~/code/superset
    git fetch upstream && git switch main && git merge upstream/main     # résoudre, tester, pousser

Puis reconstruire et réinstaller le host. Le build se fait dans Docker comme la CI ; le script `packages/cli/scripts/build-dist-linux-docker.sh` jette le tarball, d'où cette variante avec un dossier `/out` monté (ne change pas de branche avant que `out/rsync-done` existe) :

    OUT=~/superset-build && mkdir -p $OUT && REPO=~/code/superset
    docker run --rm --platform linux/amd64 -v "$REPO:/host:ro" -v "$OUT:/out" \
      -e TARGET=linux-x64 -e NODE_ARCH=x64 -e NODE_VERSION=22.22.2 -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) \
      -e RELAY_URL=https://relay.superset.sh -e SUPERSET_API_URL=https://api.superset.sh \
      -e SUPERSET_WEB_URL=https://app.superset.sh -e NEXT_PUBLIC_ROOT_DOMAIN= \
      "oven/bun:$(cat $REPO/.bun-version)" bash -euxc '
        apt-get update -qq && apt-get install -y --no-install-recommends curl python3 make g++ ca-certificates xz-utils rsync procps zsh >/dev/null
        curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /usr/local --strip-components=1
        rsync -a --exclude=node_modules --exclude=dist --exclude=.next /host/ /work/ && touch /out/rsync-done
        cd /work && bun install --frozen --ignore-scripts
        (cd $(ls -d node_modules/.bun/node-pty@*/node_modules/node-pty) && npx --yes node-gyp rebuild)
        npm rebuild @parcel/watcher
        cd packages/cli && bun run build:dist --target="$TARGET"
        bash scripts/smoke-test.sh "$PWD/dist/superset-$TARGET" "$TARGET"
        SUPERSET_HEADLESS_E2E=1 bash scripts/headless-e2e.sh "$PWD/dist/superset-$TARGET"
        cp "$PWD/dist/superset-$TARGET.tar.gz" /out/ && chown "$HOST_UID:$HOST_GID" /out/*'

Installation (sans agent en cours ; garde l'ancien build pour revenir en arrière) :

    systemctl --user stop superset-host
    superset stop --terminals
    mv ~/superset ~/superset-prev && mkdir ~/superset
    tar -xzf ~/superset-build/superset-linux-x64.tar.gz -C ~/superset
    systemctl --user start superset-host && superset status

Retour à la version officielle : même chose avec `~/superset-official-1.39.0`.

## Aide-mémoire

    /ade:plan <feature>                                            # planifier (dans claude, dans le dépôt)
    superset plan import <issues.json> --project <id> --local      # importer
    superset plan run <id> --max-parallel 3 --local                # lancer
    superset plan status <id> --local                              # suivre
    superset plan list --local                                     # tous les runs
    superset plan cancel <id> --local                              # ne plus rien démarrer
    journalctl --user -u superset-host -f | grep plan-runs         # le journal
