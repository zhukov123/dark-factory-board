#!/usr/bin/env bash
# Seed the two E2E stories (Story 1: scaffold FastAPI task API; Story 2: CRUD) and set Story 2 blocked by Story 1.
# Usage: set -a && source .env.e2e && set +a && ./scripts/seed-e2e-stories.sh [TASKBOARD_URL] [TASKBOARD_TOKEN]
# Or: TASKBOARD_URL=http://localhost:5173 TASKBOARD_TOKEN=dev-token WORKSPACE_REPO=gitea/e2e-workspace ./scripts/seed-e2e-stories.sh

set -e
TASKBOARD_URL="${1:-${TASKBOARD_URL:-http://localhost:5173}}"
TASKBOARD_TOKEN="${2:-${TASKBOARD_TOKEN:-dev-token}}"
WORKSPACE_REPO="${WORKSPACE_REPO:-}"
if [ -z "$WORKSPACE_REPO" ]; then
  echo "WORKSPACE_REPO not set. Source .env.e2e or set WORKSPACE_REPO=owner/repo"
  exit 1
fi

API="$TASKBOARD_URL"
echo "Seeding E2E stories at $API (repo: $WORKSPACE_REPO)"

# Story 1 – Scaffold a basic API to store tasks
S1=$(curl -s -X POST "$API/tickets" \
  -H "Authorization: Bearer $TASKBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Scaffold a basic API to store tasks (Python FastAPI)\",
    \"status\": \"Ready\",
    \"priority\": 1,
    \"repo\": \"$WORKSPACE_REPO\",
    \"labels\": [\"e2e\", \"api\"],
    \"acceptance_criteria\": [
      \"Project has requirements.txt with fastapi and uvicorn\",
      \"Single entry file (e.g. main.py) with FastAPI app and GET / returning {\\\"service\\\": \\\"task-api\\\", \\\"status\\\": \\\"ok\\\"}\",
      \"In-memory structure exists in code for future tasks/lists; no endpoints use it yet\",
      \"uvicorn main:app starts the server and GET / returns 200 and the expected JSON\",
      \"README describes how to install dependencies and run the API\"
    ],
    \"test_plan\": \"Run pip install -r requirements.txt and uvicorn main:app; curl GET / and confirm 200 and JSON.\",
    \"description\": \"Create a new Python project that will become a small REST API for storing tasks. Use FastAPI and Python 3.11+. Create a project root with: a requirements.txt containing fastapi and uvicorn; a single application file (e.g. main.py) that creates a FastAPI app and defines one GET endpoint at the root path / that returns JSON {\\\"service\\\": \\\"task-api\\\", \\\"status\\\": \\\"ok\\\"}. Add an in-memory list (e.g. a global or module-level list) that will later hold tasks; do not expose it yet. The app must run with uvicorn main:app --reload (or python -m uvicorn main:app) and respond with 200 at GET /. No database or persistence yet; the next story will add CRUD endpoints for tasks and task lists. Include a short README with setup (e.g. pip install -r requirements.txt, uvicorn main:app).\"
  }")
ID1=$(echo "$S1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))")
if [ -z "$ID1" ]; then
  echo "Failed to create Story 1: $S1"
  exit 1
fi
echo "Created Story 1: $ID1"

# Story 2 – CRUD for tasks and task lists
S2=$(curl -s -X POST "$API/tickets" \
  -H "Authorization: Bearer $TASKBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Add CRUD endpoints for tasks and task lists (Python FastAPI)\",
    \"status\": \"Ready\",
    \"priority\": 2,
    \"repo\": \"$WORKSPACE_REPO\",
    \"labels\": [\"e2e\", \"api\"],
    \"acceptance_criteria\": [
      \"Task list model has id, name; task model has id, title, completed, list_id\",
      \"POST/GET/PATCH/DELETE /lists and /lists/{id} implemented with correct status codes and JSON\",
      \"POST/GET/PATCH/DELETE /tasks and /tasks/{id} with optional list_id filter; correct status codes and JSON\",
      \"Deleting a list removes or orphans its tasks; all ids are UUIDs; 404 when not found\"
    ],
    \"test_plan\": \"Start the API; use curl or script to create list, create tasks (with and without list_id), get, update, delete; verify status codes and response shapes.\",
    \"description\": \"Add REST endpoints to the existing task API so clients can create, read, update, and delete tasks and task lists. Data is stored in memory. Task list: id (UUID), name. Task: id (UUID), title, completed, list_id (optional). Implement: (1) Task lists: POST /lists, GET /lists, GET /lists/{id}, PATCH /lists/{id}, DELETE /lists/{id}. (2) Tasks: POST /tasks (body title, list_id optional), GET /tasks (query list_id optional), GET /tasks/{id}, PATCH /tasks/{id}, DELETE /tasks/{id}. Use 201 create, 200 read/update, 204 delete, 404 not found. Generate UUIDs for new ids.\"
  }")
ID2=$(echo "$S2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))")
if [ -z "$ID2" ]; then
  echo "Failed to create Story 2: $S2"
  exit 1
fi
echo "Created Story 2: $ID2"

# Set Story 2 blocked by Story 1
curl -s -X PUT "$API/tickets/$ID2/deps" \
  -H "Authorization: Bearer $TASKBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"blocked_by\": [\"$ID1\"]}"
echo "Set $ID2 blocked_by $ID1"

# Write ticket IDs for verify-e2e.sh
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "$ID1" > "$REPO_ROOT/.e2e-ticket-ids"
echo "$ID2" >> "$REPO_ROOT/.e2e-ticket-ids"
echo "Wrote .e2e-ticket-ids ($ID1, $ID2)"

echo ""
echo "Pick-next should return: $ID1"
curl -s "$API/pick-next" -H "Authorization: Bearer $TASKBOARD_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ticket_id:', d.get('ticket_id'), 'reason:', d.get('reason',''))"
echo ""
echo "Done. Start DarkFactoryRun workflow, then run: ./scripts/verify-e2e.sh"
