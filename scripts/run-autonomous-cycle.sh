#!/usr/bin/env bash
# Start worker and one workflow. Workflow picks whatever ticket is Ready (pick-next, no release).
# Requires: TaskBoard API and Temporal running. Set env or use worker/.env.
# Usage: ./scripts/run-autonomous-cycle.sh

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
export WORKSPACE_PATH="${WORKSPACE_PATH:?Set WORKSPACE_PATH to your workspace directory}"
export SKIP_PR="${SKIP_PR:-1}"

echo "Stopping old worker..."
pkill -f "python main.py" 2>/dev/null || true
sleep 2

echo "Terminating old workflows..."
python terminate_old_workflows.py 2>/dev/null || true

echo "Starting worker..."
python main.py &
WORKER_PID=$!
sleep 5

echo "Starting workflow..."
python start_workflow.py

echo "Worker PID: $WORKER_PID"
echo "Monitor: Temporal UI http://localhost:8080 | Tickets: $TASKBOARD_URL/tickets | Workspace: $WORKSPACE_PATH"
