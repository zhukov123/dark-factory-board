#!/usr/bin/env bash
# Poll ticket status and workspace. Usage: ./scripts/poll-status.sh [seconds]
# Uses worker/.env for TASKBOARD_URL, TASKBOARD_TOKEN, WORKSPACE_PATH when present.

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO_ROOT/worker/.env" ]; then
  set -a
  source "$REPO_ROOT/worker/.env"
  set +a
fi

API="${TASKBOARD_URL:-http://localhost:5005}"
TOKEN="${TASKBOARD_TOKEN:-dev-token}"
WS="${WORKSPACE_PATH:-}"
if [ -z "$WS" ]; then
  echo "WORKSPACE_PATH not set. Source worker/.env or export WORKSPACE_PATH." >&2
  exit 1
fi
INTERVAL="${1:-60}"
H="Authorization: Bearer $TOKEN"

# Ticket IDs to watch (e.g. T85 T86 T87 T88 T89). Set POLL_TICKET_IDS in env to override.
TICKET_IDS="${POLL_TICKET_IDS:-T85 T86 T87 T88 T89}"
TID_COUNT=$(echo $TICKET_IDS | wc -w | tr -d ' ')

while true; do
  echo "=== $(date) ==="
  curl -s -H "$H" "$API/tickets?limit=20" | python3 -c "
import sys, json
ids = '''$TICKET_IDS'''.split()
d = json.load(sys.stdin)
for t in sorted(d.get('items', []), key=lambda x: x['id']):
    if t['id'] in ids:
        r = t.get('run') or {}
        print(f\"  {t['id']}  {t['status']:12}  {t['title'][:45]}  |  {(r.get('last_error') or '')[:40]}\")
"
  echo "Workspace ($WS): package.json=$([ -f \"$WS/package.json\" ] && echo yes || echo no)  task-manager-react/pkg=$([ -f \"$WS/task-manager-react/package.json\" ] && echo yes || echo no)"
  done_count=$(curl -s -H "$H" "$API/tickets?limit=20" | python3 -c "
import sys, json
ids = '''$TICKET_IDS'''.split()
d = json.load(sys.stdin)
items = {t['id']: t for t in d.get('items', []) if t['id'] in ids}
print(sum(1 for i in ids if items.get(i, {}).get('status') == 'Done'))
" 2>/dev/null || echo "0")
  echo "Done: $done_count/$TID_COUNT"
  [ "$done_count" = "$TID_COUNT" ] && echo "All done." && break
  sleep "$INTERVAL"
done
