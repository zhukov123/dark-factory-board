#!/usr/bin/env bash
# Seed TaskBoard with a few Ready tickets for Dark Factory E2E testing.
# Usage: ./scripts/seed-test-tickets.sh [API_BASE_URL] [AUTH_TOKEN]
# Example: ./scripts/seed-test-tickets.sh http://localhost:5005 dev-token

set -e
BASE="${1:-http://localhost:5005}"
TOKEN="${2:-dev-token}"
API="$BASE"

echo "Seeding test tickets at $API (token: ${TOKEN:0:4}...)"
echo ""

# Ticket 1: Simple doc task (no real repo needed for stub run)
curl -s -X POST "$API/tickets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Add README section for API",
    "status": "Ready",
    "priority": 1,
    "repo": "dark-factory-board",
    "labels": ["docs"],
    "acceptance_criteria": ["README has an API section", "Lists main endpoints"],
    "test_plan": "Manual check",
    "description": "Add a short section to the project README describing the TaskBoard API and how to run it."
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print('Created:', d.get('id'), d.get('title'))"

# Ticket 2: Second task for worker to pick after first completes
curl -s -X POST "$API/tickets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Document worker env vars",
    "status": "Ready",
    "priority": 2,
    "repo": "dark-factory-board",
    "labels": ["docs", "worker"],
    "acceptance_criteria": ["worker/README lists all env vars", "Each has a short description"],
    "test_plan": "Read README",
    "description": "Ensure worker/README.md documents every environment variable the worker uses."
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print('Created:', d.get('id'), d.get('title'))"

# Ticket 3: Third (optional)
curl -s -X POST "$API/tickets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Add health check to worker",
    "status": "Ready",
    "priority": 1,
    "repo": "dark-factory-board",
    "labels": ["worker"],
    "acceptance_criteria": ["Worker exposes or logs a simple health indicator"],
    "test_plan": "Start worker and verify",
    "description": "Optional: add a way to check that the worker process is alive and connected to Temporal."
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print('Created:', d.get('id'), d.get('title'))"

echo ""
echo "Listing Ready tickets:"
curl -s "$API/tickets?status=Ready&limit=10" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('items', [])
for t in items:
    print('  ', t.get('id'), t.get('title'), '-', t.get('status'))
if not items:
    print('  (none)')
"

echo ""
echo "Pick-next would choose:"
curl -s "$API/pick-next" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
tid = d.get('ticket_id')
if tid:
    print('  ', tid, '(score:', d.get('score'), ')')
else:
    print('  ', d.get('reason', 'no ticket'))
"

echo ""
echo "Done. Start the worker and a workflow to process these tickets."
