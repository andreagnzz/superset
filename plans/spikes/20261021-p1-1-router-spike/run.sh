#!/usr/bin/env bash
# Runs one headless parent that spawns one subagent, then prints what the subagent ran with.
# ROUTER_SPIKE_MODEL / ROUTER_SPIKE_EFFORT select the rewrite; SPIKE_USER_SETTINGS=1 loads user plugins.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cd "$(mktemp -d)"

sources=(--setting-sources local)
[[ "${SPIKE_USER_SETTINGS:-}" == 1 ]] && sources=()

prompt='Call the Agent tool exactly once with subagent_type "general-purpose", model "sonnet", run_in_background false, description "spike probe" and prompt "Reply with the single word OK.". Then reply DONE.'

out=$(claude -p --model sonnet --dangerously-skip-permissions --plugin-dir "$here" \
  "${sources[@]}" --output-format json "$@" "$prompt")
sid=$(jq -r .session_id <<<"$out")

shopt -s nullglob
transcripts=(~/.claude/projects/*/"$sid"/subagents/*.jsonl)
if (( ${#transcripts[@]} == 0 )); then
  echo "no subagent transcript for session $sid; parent said: $(jq -r .result <<<"$out")" >&2
  exit 1
fi
jq -c 'select(.type=="assistant") | {requestedModel, model: .message.model, effort}' "${transcripts[@]}" | sort -u
