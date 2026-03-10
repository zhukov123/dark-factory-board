#!/usr/bin/env bash
# Create a ticket for the Task Service backend API (C#, SQLite).
# Usage: ./scripts/create-task-service-backend-ticket.sh [API_URL] [TOKEN]

set -e
API="${1:-http://localhost:5005}"
TOKEN="${2:-dev-token}"
H="Authorization: Bearer $TOKEN"

# JSON body: escape inner quotes and newlines for curl -d
BODY=$(cat <<'JSON'
{
  "title": "Backend API: Task Service with SQLite (C#)",
  "status": "Ready",
  "priority": 1,
  "repo": "task-service-api",
  "description": "Build a C# backend API for a task service backed by SQLite. Support multiple task lists, add/remove tasks, due dates, and copy list.\n\n## Database (SQLite)\n\nUse SQLite with Microsoft.Data.Sqlite (or equivalent). Schema:\n\n**TaskLists**\n- Id (INTEGER PRIMARY KEY AUTOINCREMENT)\n- Name (TEXT NOT NULL)\n- CreatedAt (TEXT ISO8601)\n\n**Tasks**\n- Id (INTEGER PRIMARY KEY AUTOINCREMENT)\n- TaskListId (INTEGER NOT NULL, FK -> TaskLists.Id ON DELETE CASCADE)\n- Title (TEXT NOT NULL)\n- Completed (INTEGER 0/1)\n- DueDate (TEXT ISO8601 nullable)\n- CreatedAt (TEXT ISO8601)\n\n## API (REST)\n\n- Task lists: GET/POST /lists, GET/PATCH/DELETE /lists/{id}\n- Tasks: GET/POST /lists/{listId}/tasks, GET/PATCH/DELETE /lists/{listId}/tasks/{id}\n- Copy list: POST /lists/{id}/copy -> creates new list with same name + \" (copy)\" and copies all tasks (new ids, same title/completed/due dates)\n- Add task: POST body { \"title\", \"dueDate\"? }\n- Remove task: DELETE\n- Support filtering tasks by due date (e.g. query param) if time permits.\n\nImplement in C# (ASP.NET Core minimal API or MVC). Use EF Core with SQLite or direct SQLite ADO.",
  "acceptance_criteria": [
    "SQLite database with TaskLists and Tasks tables per schema above",
    "API: create and list task lists; add and remove tasks in a list",
    "Tasks have optional due date (stored and returned in API)",
    "Copy list endpoint creates a new list with copied tasks (new IDs, same title/completed/dueDate)",
    "C# project runs (e.g. dotnet run) and exposes the endpoints; DB file created on first run"
  ],
  "test_plan": "Start API, create a list, add tasks with and without due dates, copy list, verify data in SQLite and via API. Remove a task and a list; confirm 404 or empty as appropriate."
}
JSON
)

RESP=$(curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d "$BODY")

echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tid = d.get('id', '')
print('Created ticket:', tid)
print('Run workflow with: RELEASE_TICKET_ID=' + tid + ' ./scripts/run-autonomous-cycle.sh')
" 2>/dev/null || echo "$RESP"
