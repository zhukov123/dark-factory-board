#!/usr/bin/env bash
# Check that E2E environment is ready: Gitea or GitHub, WORKSPACE_REPO, TaskBoard, LLM.
# Usage: source .env.e2e 2>/dev/null; ./scripts/check-e2e-env.sh

ok=0
if [ -n "$GITEA_URL" ] && [ -n "$GITEA_TOKEN" ]; then
  echo "Git: Gitea ($GITEA_URL)"
else
  if [ -n "$GITHUB_TOKEN" ]; then
    echo "Git: GitHub"
  else
    echo "Git: missing (set GITEA_URL+GITEA_TOKEN or GITHUB_TOKEN)"
    ok=1
  fi
fi

if [ -z "$WORKSPACE_REPO" ] && [ -z "$WORKSPACE_PATH" ]; then
  echo "Workspace: missing (set WORKSPACE_REPO or WORKSPACE_PATH)"
  ok=1
else
  echo "Workspace: ${WORKSPACE_REPO:-$WORKSPACE_PATH}"
fi

if [ -z "$TASKBOARD_URL" ]; then
  echo "TaskBoard: missing (set TASKBOARD_URL)"
  ok=1
else
  echo "TaskBoard: $TASKBOARD_URL"
fi

if [ -z "$TASKBOARD_TOKEN" ]; then
  echo "TaskBoard token: missing (set TASKBOARD_TOKEN)"
  ok=1
fi

if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$LMSTUDIO_BASE_URL" ]; then
  echo "LLM: missing (set OPENROUTER_API_KEY or LMSTUDIO_BASE_URL)"
  ok=1
else
  echo "LLM: configured"
fi

if [ $ok -eq 0 ]; then
  echo "E2E env OK."
else
  echo "Fix the above and re-run."
  exit 1
fi
