#!/usr/bin/env bash
# Create a single ticket for troubleshooting: "Create a task tracker".
# Usage: ./scripts/create-task-tracker-ticket.sh [API_URL] [TOKEN]
# Example: ./scripts/create-task-tracker-ticket.sh http://localhost:5005 dev-token

set -e
API="${1:-http://localhost:5005}"
TOKEN="${2:-dev-token}"
H="Authorization: Bearer $TOKEN"

RESP=$(curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d '{
  "title": "Create a task tracker",
  "status": "Ready",
  "priority": 1,
  "repo": "task-manager-react",
  "description": "Build a minimal task tracker: a single page or component that lists tasks and allows adding and marking tasks complete. Keep scope small for testing the pipeline (e.g. in-memory state, no backend).",
  "acceptance_criteria": [
    "Task list is visible with at least one sample task",
    "User can add a new task (title only is fine)",
    "User can mark a task complete (e.g. checkbox)"
  ],
  "test_plan": "Run the app, add a task, mark one complete; confirm no errors."
}')

echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tid = d.get('id', '')
print('Created ticket:', tid)
print('Run workflow with: RELEASE_TICKET_ID=' + tid + ' ./scripts/run-autonomous-cycle.sh')
" 2>/dev/null || echo "$RESP"
