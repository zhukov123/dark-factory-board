#!/usr/bin/env bash
# Poll ticket status and workspace for a few cycles.
# Usage: ./scripts/monitor-workflow.sh [API_URL] [TOKEN] [WORKSPACE_PATH]

API="${1:-http://localhost:5005}"
TOKEN="${2:-dev-token}"
WORKSPACE="${3:-/Users/vishwakapoor/Documents/Code/GitHub/factory-workspace-1}"
H="Authorization: Bearer $TOKEN"

echo "=== Monitor: tickets + workspace ($(date -Iseconds 2>/dev/null || date)) ==="
echo "API: $API  Workspace: $WORKSPACE"
echo ""

for round in 1 2 3 4 5 6 7 8 9 10; do
  echo "--- Round $round ---"
  curl -s -H "$H" "$API/tickets?limit=10" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in sorted(d.get('items', []), key=lambda x: x['id']):
    r = t.get('run') or {}
    err = (r.get('last_error') or '')[:60]
    print(f\"  {t['id']} {t['status']:12} {t['title'][:50]}...\")
    if err:
        print(f\"      last_error: {err}\")
"
  echo "Workspace files (top-level):"
  ls -la "$WORKSPACE" 2>/dev/null | grep -v '^\.$' | head -25
  echo ""
  sleep 18
done

echo "Done monitoring."
