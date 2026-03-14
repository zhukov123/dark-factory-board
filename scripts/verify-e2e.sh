#!/usr/bin/env bash
# Verify 2-ticket E2E: poll until both tickets are Done, then assert run has pr_url/pr_number and (optional) Gitea repo has commits.
# Usage: set -a && source .env.e2e && set +a && ./scripts/verify-e2e.sh [TICKET_ID_1 TICKET_ID_2]
# If no args, reads .e2e-ticket-ids (created by seed-e2e-stories.sh).
# Exit 0 if all checks pass, 1 otherwise. Timeout 35 minutes for both tickets to complete.

set -e
TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5173}"
TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
GITEA_URL="${GITEA_URL:-}"
GITEA_TOKEN="${GITEA_TOKEN:-}"
WORKSPACE_REPO="${WORKSPACE_REPO:-}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 2 ]; then
  ID1="$1"
  ID2="$2"
else
  if [ ! -f "$REPO_ROOT/.e2e-ticket-ids" ]; then
    echo "Usage: ./scripts/verify-e2e.sh TICKET_ID_1 TICKET_ID_2"
    echo "Or run seed-e2e-stories.sh first so .e2e-ticket-ids exists."
    exit 1
  fi
  ID1=$(sed -n '1p' "$REPO_ROOT/.e2e-ticket-ids")
  ID2=$(sed -n '2p' "$REPO_ROOT/.e2e-ticket-ids")
fi

API="$TASKBOARD_URL"
TIMEOUT_SEC=$((35 * 60))
POLL_INTERVAL=60
DEADLINE=$(($(date +%s) + TIMEOUT_SEC))

echo "E2E verify: $ID1, $ID2 at $API (timeout ${TIMEOUT_SEC}s)"

# Poll until both Done
while true; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    echo "FAIL: Timeout before both tickets Done."
    exit 1
  fi
  S1=$(curl -s -H "Authorization: Bearer $TASKBOARD_TOKEN" "$API/tickets/$ID1")
  S2=$(curl -s -H "Authorization: Bearer $TASKBOARD_TOKEN" "$API/tickets/$ID2")
  ST1=$(echo "$S1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))")
  ST2=$(echo "$S2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))")
  echo "  $(date -u +%H:%M:%S) $ID1=$ST1 $ID2=$ST2"
  if [ "$ST1" = "Done" ] && [ "$ST2" = "Done" ]; then
    break
  fi
  sleep "$POLL_INTERVAL"
done

echo "Both tickets Done. Checking run PR link and repo..."

FAIL=0

# Check each ticket run has pr_url or pr_number
for ID in "$ID1" "$ID2"; do
  T=$(curl -s -H "Authorization: Bearer $TASKBOARD_TOKEN" "$API/tickets/$ID")
  RUN=$(echo "$T" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('run'); print(json.dumps(r))" 2>/dev/null || echo "null")
  if [ "$RUN" = "null" ] || [ -z "$RUN" ]; then
    echo "FAIL: $ID has no run."
    FAIL=1
    continue
  fi
  PR_URL=$(echo "$RUN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pr_url') or '')" 2>/dev/null)
  PR_NUM=$(echo "$RUN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pr_number') or '')" 2>/dev/null)
  if [ -n "$PR_URL" ]; then
    echo "  $ID: pr_url=$PR_URL"
  elif [ -n "$PR_NUM" ]; then
    echo "  $ID: pr_number=$PR_NUM"
  else
    echo "FAIL: $ID run has no pr_url and no pr_number (PR was not recorded in TaskBoard)."
    FAIL=1
  fi
done

# Optional: Gitea repo has commits
if [ -n "$GITEA_URL" ] && [ -n "$GITEA_TOKEN" ] && [ -n "$WORKSPACE_REPO" ]; then
  OWNER="${WORKSPACE_REPO%%/*}"
  REPO="${WORKSPACE_REPO#*/}"
  COMMITS=$(curl -s -H "Authorization: token $GITEA_TOKEN" "$GITEA_URL/api/v1/repos/$OWNER/$REPO/commits?limit=1" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo "0")
  if [ "${COMMITS:-0}" -gt 0 ]; then
    echo "  Gitea repo $WORKSPACE_REPO: has commits."
  else
    echo "WARN: Gitea repo $WORKSPACE_REPO: no commits (worker may not have pushed)."
    FAIL=1
  fi
fi

if [ $FAIL -eq 0 ]; then
  echo "E2E verify PASSED: both tickets Done, PR(s) recorded in TaskBoard."
  exit 0
fi
echo "E2E verify FAILED."
exit 1
