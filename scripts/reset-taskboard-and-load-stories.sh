#!/usr/bin/env bash
# Reset TaskBoard database and load web-text-editor stories from scratch.
#
# Usage:
#   ./scripts/reset-taskboard-and-load-stories.sh
#
# What it does:
#   1. Stops taskboard and worker (so the DB volume can be removed)
#   2. Removes the taskboard-data volume (wipes all tickets, runs, events)
#   3. Builds taskboard and worker images (so you run latest code)
#   4. Starts taskboard (fresh DB, migrations run automatically)
#   5. Waits for taskboard to be healthy
#   6. Loads docs/samples/stories-web-text-editor.json (10 tickets + deps)
#   7. Terminates existing dark-factory workflows (Temporal is not reset)
#   8. Starts the worker (entrypoint starts one DarkFactoryRun workflow)
#
# Optional: pass a different story file and/or GITEA_OWNER:
#   STORIES_FILE=docs/samples/my-stories.json GITEA_OWNER=myorg ./scripts/reset-taskboard-and-load-stories.sh
#
# Optional: skip starting the worker (e.g. you will start it yourself with custom env):
#   SKIP_WORKER=1 ./scripts/reset-taskboard-and-load-stories.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

STORIES_FILE="${STORIES_FILE:-docs/samples/stories-web-text-editor.json}"
TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5173}"
TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
GITEA_OWNER="${GITEA_OWNER:-gitea}"

echo "=== Reset TaskBoard and load stories ==="
echo "  Stories: $STORIES_FILE"
echo "  TaskBoard: $TASKBOARD_URL"
echo ""

# 1. Stop and remove taskboard and worker containers so the volume can be removed
echo "Stopping and removing taskboard and worker containers..."
docker compose stop taskboard worker 2>/dev/null || true
docker compose rm -f taskboard worker 2>/dev/null || true

# 2. Remove the TaskBoard database volume and worker workspace volume (clean slate)
VOLUME_NAME="dark-factory-board_taskboard-data"
if docker volume inspect "$VOLUME_NAME" &>/dev/null; then
  echo "Removing volume $VOLUME_NAME..."
  docker volume rm "$VOLUME_NAME"
else
  echo "Volume $VOLUME_NAME not found (already fresh?)."
fi
WORKER_VOLUME="dark-factory-board_worker-workspace"
if docker volume inspect "$WORKER_VOLUME" &>/dev/null; then
  echo "Removing worker workspace volume $WORKER_VOLUME (clean workspace for next run)..."
  docker volume rm "$WORKER_VOLUME"
else
  echo "Volume $WORKER_VOLUME not found (already fresh?)."
fi

# 3. Build images so we run latest code
echo "Building taskboard and worker images..."
docker compose build taskboard worker

# 4. Start taskboard (worker will start too if in compose)
echo "Starting taskboard..."
docker compose up -d taskboard

# 5. Wait for taskboard to be healthy
echo "Waiting for taskboard to be healthy..."
for i in $(seq 1 30); do
  if docker compose ps taskboard 2>/dev/null | grep -q "healthy"; then
    break
  fi
  [ "$i" -eq 30 ] && { echo "Taskboard did not become healthy."; exit 1; }
  sleep 2
done
echo "Taskboard is healthy."

# 6. Load stories
echo ""
export TASKBOARD_URL TASKBOARD_TOKEN GITEA_OWNER
"$REPO_ROOT/scripts/load-stories.sh" "$STORIES_FILE"

# 7. Terminate existing workflows (Temporal is not reset, so old workflows persist; avoid multiple runners)
echo "Terminating existing dark-factory workflows..."
docker compose run --rm --entrypoint python worker terminate_old_workflows.py 2>/dev/null || true

# 8. Start worker (entrypoint starts one DarkFactoryRun workflow)
if [ "${SKIP_WORKER:-0}" = "1" ]; then
  echo ""
  echo "Done. Start the worker when ready: docker compose up -d worker"
else
  echo ""
  echo "Starting worker (one workflow will start)..."
  if [ -f "$REPO_ROOT/.env.e2e" ]; then
    docker compose --env-file "$REPO_ROOT/.env.e2e" up -d worker
  else
    docker compose up -d worker
  fi
  echo ""
  echo "Done. Open $TASKBOARD_URL — move tickets to Ready and the worker will pick them up."
  echo "Temporal UI: http://localhost:8080 (workflow is already running)."
fi
