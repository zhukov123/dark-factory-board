#!/usr/bin/env bash
# Soft-delete all tickets, then seed exactly two E2E stories (Story 1 + Story 2, second blocked by first).
# Usage: set -a && source .env.e2e && set +a && ./scripts/reset-e2e-tickets.sh [TASKBOARD_URL] [TASKBOARD_TOKEN]
# Ensures only two tasks exist and both are Ready for a clean E2E run.

set -e
TASKBOARD_URL="${1:-${TASKBOARD_URL:-http://localhost:5173}}"
TASKBOARD_TOKEN="${2:-${TASKBOARD_TOKEN:-dev-token}}"
API="$TASKBOARD_URL"

echo "Resetting E2E: delete all tickets, then seed two..."
IDS=$(curl -s -H "Authorization: Bearer $TASKBOARD_TOKEN" "$API/tickets?limit=100" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(' '.join(t['id'] for t in d.get('items', [])))
" 2>/dev/null || true)
for id in $IDS; do
  curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TASKBOARD_TOKEN" "$API/tickets/$id" && echo "  Deleted $id" || true
done
echo "Seeding two stories..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export TASKBOARD_URL TASKBOARD_TOKEN
"$SCRIPT_DIR/seed-e2e-stories.sh" "$TASKBOARD_URL" "$TASKBOARD_TOKEN"
echo "Done. Only two tickets exist (Ready). Start worker + workflow, then ./scripts/verify-e2e.sh"
