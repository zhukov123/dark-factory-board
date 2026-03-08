#!/usr/bin/env bash
# Run one autonomous cycle: terminate old workflows, release first ticket (e.g. T85), start worker + one workflow.
# Requires: TaskBoard API and Temporal running. Set env or use worker/.env.
# Usage: ./scripts/run-autonomous-cycle.sh [FIRST_TICKET_ID]
# Default FIRST_TICKET_ID: T85 (or set RELEASE_TICKET_ID in env)

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"
cd "$WORKER_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5005}"
export TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
export WORKSPACE_PATH="${WORKSPACE_PATH:-/Users/vishwakapoor/Documents/Code/GitHub/factory-workspace-1}"
export SKIP_PR="${SKIP_PR:-1}"
# OpenRouter or LM Studio: set in .env. OpenRouter used when OPENROUTER_API_KEY is set.
RELEASE_TICKET_ID="${RELEASE_TICKET_ID:-${1:-T85}}"

echo "Stopping old worker..."
pkill -f "python main.py" 2>/dev/null || true
sleep 2

echo "Terminating old workflows..."
python terminate_old_workflows.py 2>/dev/null || true

echo "Releasing $RELEASE_TICKET_ID and setting Ready..."
curl -s -X POST "$TASKBOARD_URL/runs/release" -H "Authorization: Bearer $TASKBOARD_TOKEN" -H "Content-Type: application/json" -d "{\"ticket_id\":\"$RELEASE_TICKET_ID\",\"owner\":\"worker-1\"}" >/dev/null || true
curl -s -X PATCH "$TASKBOARD_URL/tickets/$RELEASE_TICKET_ID" -H "Authorization: Bearer $TASKBOARD_TOKEN" -H "Content-Type: application/json" -d '{"status":"Ready"}' -o /dev/null || true

echo "Starting worker..."
python main.py &
WORKER_PID=$!
sleep 5

echo "Starting workflow..."
python start_workflow.py

echo "Worker PID: $WORKER_PID"
echo "Monitor: Temporal UI http://localhost:8080 | Tickets: $TASKBOARD_URL/tickets | Workspace: $WORKSPACE_PATH"
