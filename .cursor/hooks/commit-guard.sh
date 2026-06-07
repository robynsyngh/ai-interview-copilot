#!/usr/bin/env bash
#
# Cursor hook (beforeShellExecution): gate `git commit` on
#   1) Conventional Commit message format
#   2) lint + type-check + naming for the workspaces with staged changes
#
# Input  : JSON on stdin  ({ "command": "...", "cwd": "..." })
# Output : JSON on stdout ({ "permission": "allow" | "deny", ... })
#
# Fails OPEN on its own internal errors (never locks you out of committing);
# only denies when a check actually reports a problem.

set -uo pipefail

input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.command // empty' 2>/dev/null)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"

allow() { printf '{"permission":"allow"}\n'; exit 0; }
deny() {
  # $1 = user_message, $2 = agent_message
  jq -n --arg u "$1" --arg a "$2" \
    '{permission:"deny", user_message:$u, agent_message:$a}'
  exit 0
}

# Only gate real `git commit` invocations.
printf '%s' "$command" | grep -Eq '\bgit\b[^&|;]*\bcommit\b' || allow
# Respect an explicit bypass.
printf '%s' "$command" | grep -Eq '\-\-no-verify' && allow

# Resolve the repo root (prefer the command's own cwd).
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || allow
cd "$REPO_ROOT" 2>/dev/null || allow

# ---------------------------------------------------------------------------
# 1) Commit message — Conventional Commits
# ---------------------------------------------------------------------------
header="$(COMMITCMD="$command" perl "$REPO_ROOT/.cursor/hooks/parse-commit-header.pl" 2>/dev/null)"

if [ -n "$header" ]; then
  TYPES='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
  is_special="$(printf '%s' "$header" | grep -Eq '^(Merge |Revert "|fixup! |squash! )' && echo yes || echo no)"
  if [ "$is_special" = "no" ] \
     && ! printf '%s' "$header" | grep -Eq "^(${TYPES})(\([a-z0-9._/-]+\))?!?: .+"; then
    deny \
      "Commit message must follow Conventional Commits: <type>(<scope>): <subject>." \
      "Commit blocked: \"$header\" is not a Conventional Commit. Allowed types: ${TYPES//|/, }. Example: feat(web): add nav highlight. Rewrite the message and retry."
  fi
fi

# ---------------------------------------------------------------------------
# 2) Lint + type-check + naming on staged files only
# ---------------------------------------------------------------------------
STAGED="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)"
[ -z "$STAGED" ] && allow

TMP="$(mktemp 2>/dev/null)" || allow
FAILED=0
matches() { printf '%s\n' "$STAGED" | grep -Eq "$1"; }
runcheck() {
  local label="$1"; shift
  # NOTE: all output must go to $TMP, never stdout — stdout is reserved for the
  # final permission JSON. A stray echo here corrupts the hook's JSON response.
  if ! { echo "### $label"; "$@"; } >>"$TMP" 2>&1; then
    echo ">>> FAILED: $label" >>"$TMP"
    FAILED=1
  fi
}

if matches '^apps/web/.*\.(ts|tsx|js|jsx)$'; then
  runcheck "web · eslint (incl. naming)" pnpm --filter @copilot/web lint
  runcheck "web · typecheck"             pnpm --filter @copilot/web typecheck
fi
if matches '^apps/extension/.*\.(ts|tsx)$'; then
  runcheck "extension · typecheck" pnpm --filter @copilot/extension typecheck
fi
if matches '^packages/shared/.*\.ts$'; then
  runcheck "shared · typecheck" pnpm --filter @copilot/shared typecheck
fi

PY_STAGED="$(printf '%s\n' "$STAGED" | grep -E '^apps/api/.*\.py$' || true)"
if [ -n "$PY_STAGED" ]; then
  # shellcheck disable=SC2086  (intentional word-splitting of the file list)
  if command -v ruff >/dev/null 2>&1; then
    runcheck "api · ruff check"  ruff check $PY_STAGED
    runcheck "api · ruff format" ruff format --check $PY_STAGED
  elif python3 -m ruff --version >/dev/null 2>&1; then
    runcheck "api · ruff check"  python3 -m ruff check $PY_STAGED
    runcheck "api · ruff format" python3 -m ruff format --check $PY_STAGED
  elif command -v uvx >/dev/null 2>&1; then
    runcheck "api · ruff check"  uvx ruff check $PY_STAGED
    runcheck "api · ruff format" uvx ruff format --check $PY_STAGED
  elif command -v docker >/dev/null 2>&1; then
    RUFF_IMG="ghcr.io/astral-sh/ruff:latest"
    runcheck "api · ruff check"  docker run --rm -v "$REPO_ROOT:/io" -w /io "$RUFF_IMG" check $PY_STAGED
    runcheck "api · ruff format" docker run --rm -v "$REPO_ROOT:/io" -w /io "$RUFF_IMG" format --check $PY_STAGED
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  OUT="$(tail -c 1800 "$TMP")"
  rm -f "$TMP"
  deny \
    "Pre-commit checks failed (lint / type-check / naming). Fix the issues, then commit again." \
    "Commit blocked by failing checks. Output:"$'\n'"$OUT"
fi

rm -f "$TMP"
allow
