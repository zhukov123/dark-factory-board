#!/usr/bin/env bash
# Delete task-manager tickets T80–T84 (if present) and recreate 5 new ones with dependencies.
# Usage: ./scripts/clear-and-recreate-taskmanager-tickets.sh [API_URL] [TOKEN]

set -e
API="${1:-http://localhost:5005}"
TOKEN="${2:-dev-token}"
H="Authorization: Bearer $TOKEN"

echo "Deleting existing task-manager tickets (T80–T84)..."
for id in T80 T81 T82 T83 T84; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/tickets/$id" -H "$H")
  if [ "$code" = "204" ]; then
    echo "  Deleted $id"
  elif [ "$code" = "404" ]; then
    echo "  $id not found (skip)"
  else
    echo "  $id: HTTP $code"
  fi
done

echo ""
echo "Creating 5 new task-manager tickets with dependencies..."
exec "$(dirname "$0")/create-taskmanager-tickets.sh" "$API" "$TOKEN"
