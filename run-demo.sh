#!/usr/bin/env bash
#
# Dark Factory — 2-Ticket E2E Demo
#
# Run this script to watch the full autonomous coding pipeline:
#   1. Spins up TaskBoard, Temporal, and Gitea via Docker Compose
#   2. Bootstraps Gitea with a fresh repo (unique per run)
#   3. Seeds two linked tickets (Story 1 → Story 2)
#   4. Starts the AI worker which plans, implements, reviews, PRs, and merges
#   5. Monitors progress until both tickets are Done
#
# Prerequisites:
#   - Docker & Docker Compose
#   - Python 3.10+ with pip
#   - An OpenRouter API key (https://openrouter.ai)
#
# Usage:
#   ./run-demo.sh                              # interactive — prompts for key + model
#   OPENROUTER_API_KEY=sk-... ./run-demo.sh    # non-interactive with defaults

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

banner() { echo -e "\n${CYAN}${BOLD}═══  $1  ═══${NC}\n"; }
info()   { echo -e "${GREEN}✓${NC} $1"; }
warn()   { echo -e "${YELLOW}⚠${NC} $1"; }
fail()   { echo -e "${RED}✗${NC} $1"; exit 1; }

cleanup() {
  if [ -n "${WORKER_PID:-}" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── 0. Preflight ───────────────────────────────────────────────────────
banner "Preflight"

command -v docker >/dev/null 2>&1   || fail "docker is required."
command -v python3 >/dev/null 2>&1  || fail "python3 is required."
docker info >/dev/null 2>&1         || fail "Docker daemon is not running."
info "Docker and Python3 found"

# ── 1. LLM config ─────────────────────────────────────────────────────
banner "LLM Configuration"

ENV_FILE="$REPO_ROOT/.env.e2e"
[ -f "$ENV_FILE" ] && { set -a; source "$ENV_FILE" 2>/dev/null || true; set +a; }

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  if [ -t 0 ]; then
    echo -e "${BOLD}Enter your OpenRouter API key${NC} (https://openrouter.ai/keys):"
    read -r -s OPENROUTER_API_KEY; echo ""
  fi
  [ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY required. Export it or run interactively."
fi
info "API key set"

if [ -t 0 ]; then
  echo ""
  echo -e "${BOLD}Select LLM model:${NC}"
  echo "  1) minimax/minimax-m2.5  (fast, cheap — recommended)"
  echo "  2) openai/gpt-4o-mini"
  echo "  3) anthropic/claude-3.5-sonnet"
  echo "  4) google/gemini-2.0-flash"
  echo "  5) Custom"
  [ -n "${OPENROUTER_MODEL:-}" ] && echo -e "  Current: ${CYAN}${OPENROUTER_MODEL}${NC}  (Enter to keep)"
  read -r -p "  Choice [1]: " MODEL_CHOICE || MODEL_CHOICE=""
  case "${MODEL_CHOICE:-1}" in
    1) OPENROUTER_MODEL="minimax/minimax-m2.5" ;;
    2) OPENROUTER_MODEL="openai/gpt-4o-mini" ;;
    3) OPENROUTER_MODEL="anthropic/claude-3.5-sonnet" ;;
    4) OPENROUTER_MODEL="google/gemini-2.0-flash-001" ;;
    5) read -r -p "  Model ID: " OPENROUTER_MODEL; [ -z "$OPENROUTER_MODEL" ] && fail "Model ID required." ;;
    "") OPENROUTER_MODEL="${OPENROUTER_MODEL:-minimax/minimax-m2.5}" ;;
    *) OPENROUTER_MODEL="minimax/minimax-m2.5" ;;
  esac
else
  OPENROUTER_MODEL="${OPENROUTER_MODEL:-minimax/minimax-m2.5}"
fi
info "Model: $OPENROUTER_MODEL"

# Unique repo name per run
RUN_ID=$(python3 -c "import uuid; print(uuid.uuid4().hex[:8])")
DEMO_REPO_NAME="e2e-demo-${RUN_ID}"

cat > "$ENV_FILE" <<EOF
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
OPENROUTER_MODEL=$OPENROUTER_MODEL
TASKBOARD_URL=http://localhost:5173
TASKBOARD_TOKEN=dev-token
WORKSPACE_PATH=
EOF

# ── 2. Infrastructure ─────────────────────────────────────────────────
banner "Starting Infrastructure"

docker compose up -d taskboard temporal temporal-ui gitea 2>&1 | tail -3

echo "Waiting for services..."
for svc in taskboard gitea; do
  for i in $(seq 1 60); do
    docker compose ps "$svc" 2>/dev/null | grep -q "healthy" && break
    [ "$i" -eq 60 ] && fail "$svc not healthy. Run: docker compose logs $svc"
    sleep 2
  done
  info "$svc healthy"
done

for i in $(seq 1 30); do
  python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('localhost',7233)); s.close()" 2>/dev/null && break
  [ "$i" -eq 30 ] && warn "Temporal port 7233 slow to start"
  sleep 2
done
info "Temporal reachable"

echo ""
echo -e "  TaskBoard: ${CYAN}http://localhost:5173${NC}   Temporal: ${CYAN}http://localhost:8080${NC}   Gitea: ${CYAN}http://localhost:3000${NC}"

# ── 3. Bootstrap Gitea (fresh repo per run) ────────────────────────────
banner "Bootstrapping Gitea"

GITEA_URL="http://localhost:3000"
ADMIN_USER="gitea"
ADMIN_PASS="gitea"

# Wait for Gitea API
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}" "$GITEA_URL/api/healthz" 2>/dev/null | grep -q 200 && break
  [ "$i" -eq 30 ] && fail "Gitea API not ready"
  sleep 2
done

# Create admin (idempotent)
CONTAINER=$(docker ps -q -f "name=gitea" 2>/dev/null | head -1)
[ -n "$CONTAINER" ] && docker exec -u git "$CONTAINER" gitea admin user create \
  --username "$ADMIN_USER" --password "$ADMIN_PASS" --email "${ADMIN_USER}@local" \
  --admin --must-change-password=false 2>/dev/null || true

# Fresh API token
curl -s -X DELETE "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens/e2e" -u "$ADMIN_USER:$ADMIN_PASS" >/dev/null 2>&1 || true
TOKEN_RESP=$(curl -s -X POST "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens" \
  -u "$ADMIN_USER:$ADMIN_PASS" -H "Content-Type: application/json" \
  -d '{"name":"e2e","scopes":["all"]}')
GITEA_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha1',''))" 2>/dev/null)
[ -z "$GITEA_TOKEN" ] && fail "Gitea token creation failed: $TOKEN_RESP"

# Create fresh repo with unique name
curl -s -X POST "$GITEA_URL/api/v1/user/repos" \
  -H "Authorization: token $GITEA_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"$DEMO_REPO_NAME\",\"auto_init\":false}" >/dev/null
WORKSPACE_REPO="$ADMIN_USER/$DEMO_REPO_NAME"

# Append to .env.e2e
cat >> "$ENV_FILE" <<EOF
GITEA_URL=$GITEA_URL
GITEA_TOKEN=$GITEA_TOKEN
WORKSPACE_REPO=$WORKSPACE_REPO
EOF

info "Fresh repo: ${CYAN}$WORKSPACE_REPO${NC}"

# ── 4. Python venv ────────────────────────────────────────────────────
banner "Python Dependencies"

VENV_DIR="$REPO_ROOT/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment..."
  python3 -m venv "$VENV_DIR"
fi
export PATH="$VENV_DIR/bin:$PATH" VIRTUAL_ENV="$VENV_DIR"

pip install -q -r "$REPO_ROOT/worker/requirements.txt" 2>&1 | tail -3
python3 -c "import temporalio; import httpx; import langgraph" 2>/dev/null \
  || fail "Missing packages. Run: pip install -r worker/requirements.txt"
info "Dependencies ready"

# ── 5. Seed tickets ──────────────────────────────────────────────────
banner "Seeding Tickets"

set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
bash "$REPO_ROOT/scripts/reset-e2e-tickets.sh" 2>&1 | while IFS= read -r line; do echo "  $line"; done

TICKET1=$(sed -n '1p' "$REPO_ROOT/.e2e-ticket-ids" 2>/dev/null || echo "?")
TICKET2=$(sed -n '2p' "$REPO_ROOT/.e2e-ticket-ids" 2>/dev/null || echo "?")
info "Tickets: ${BOLD}$TICKET1${NC} (scaffold) → ${BOLD}$TICKET2${NC} (CRUD)"

# ── 6. Clean old workflows ──────────────────────────────────────────
cd "$REPO_ROOT/worker"
set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
python3 terminate_old_workflows.py >/dev/null 2>&1 || true
info "Old workflows cleaned up"

# ── 7. Start worker ─────────────────────────────────────────────────
banner "Starting Worker"

rm -rf /tmp/dark-factory-workspaces
mkdir -p "$REPO_ROOT/logs"

cd "$REPO_ROOT/worker"
set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
python3 -u main.py > "$REPO_ROOT/logs/worker.log" 2>&1 &
WORKER_PID=$!
sleep 3
kill -0 "$WORKER_PID" 2>/dev/null || fail "Worker died. Check: cat logs/worker.log"
info "Worker running (PID $WORKER_PID)"

# ── 8. Start workflow ───────────────────────────────────────────────

python3 -c "
import asyncio, time
from temporalio.client import Client
async def main():
    c = await Client.connect('localhost:7233')
    wf = await c.start_workflow(
        'DarkFactoryRun',
        args=['${WORKSPACE_REPO}', 'worker-1', 1800, 30, 600, False],
        id=f'dark-factory-demo-{int(time.time())}',
        task_queue='dark-factory',
    )
    print(f'  Workflow: {wf.id}')
asyncio.run(main())
" 2>&1
info "Workflow started"

# ── 9. Monitor ──────────────────────────────────────────────────────
banner "Monitoring"

echo -e "  ${BOLD}$TICKET1${NC} → plan → implement → review → PR → merge"
echo -e "  ${BOLD}$TICKET2${NC} → plan → implement → review → PR → merge"
echo ""
echo -e "  Live log:   ${CYAN}tail -f logs/worker.log${NC}"
echo -e "  TaskBoard:  ${CYAN}http://localhost:5173${NC}"
echo -e "  Gitea:      ${CYAN}http://localhost:3000/$WORKSPACE_REPO${NC}"
echo ""

TIMEOUT_SEC=$((20 * 60))
POLL=10
DEADLINE=$(($(date +%s) + TIMEOUT_SEC))
START_TIME=$(date +%s)
LAST_LOG_LINE=""

get_status() {
  curl -s -H "Authorization: Bearer dev-token" "http://localhost:5173/tickets/$1" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?"
}

while true; do
  NOW=$(date +%s)
  [ "$NOW" -ge "$DEADLINE" ] && { echo ""; fail "Timeout (${TIMEOUT_SEC}s). Check logs/worker.log"; }

  ST1=$(get_status "$TICKET1")
  ST2=$(get_status "$TICKET2")
  ELAPSED=$((NOW - START_TIME))
  MINS=$((ELAPSED / 60)); SECS=$((ELAPSED % 60))

  # Show latest meaningful worker activity
  NEW_LOG=$(tail -5 "$REPO_ROOT/logs/worker.log" 2>/dev/null \
    | grep -E '(Prepare|Execute|PLANNER|Implementer|REVIEWER|open_or_update|wait_for_review|close_task|Push|merge|Creating|verdict)' 2>/dev/null \
    | tail -1 | sed 's/^.*INFO //' | head -c 55 || true)
  [ -z "$NEW_LOG" ] && NEW_LOG="working..."

  printf "\r  [%02d:%02d] %-4s=%-12s %-4s=%-12s  %s\033[K" \
    "$MINS" "$SECS" "$TICKET1" "$ST1" "$TICKET2" "$ST2" "$NEW_LOG"

  if [ "$ST1" = "Done" ] && [ "$ST2" = "Done" ]; then
    echo ""
    break
  fi

  kill -0 "$WORKER_PID" 2>/dev/null || { echo ""; fail "Worker died. Check logs/worker.log"; }
  sleep "$POLL"
done

# ── 10. Results ─────────────────────────────────────────────────────
banner "Results"

TOTAL=$(($(date +%s) - START_TIME))
info "Both tickets completed in $((TOTAL / 60))m $((TOTAL % 60))s"
echo ""

for ID in "$TICKET1" "$TICKET2"; do
  T=$(curl -s -H "Authorization: Bearer dev-token" "http://localhost:5173/tickets/$ID" 2>/dev/null)
  TITLE=$(echo "$T" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title',''))" 2>/dev/null)
  PR_NUM=$(echo "$T" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('run',{}); print(r.get('pr_number',''))" 2>/dev/null)
  echo -e "  ${BOLD}$ID${NC}: $TITLE"
  [ -n "$PR_NUM" ] && [ "$PR_NUM" != "None" ] && \
    echo -e "       PR: ${CYAN}http://localhost:3000/$WORKSPACE_REPO/pulls/$PR_NUM${NC}"
done

echo ""
if [ -n "${GITEA_TOKEN:-}" ]; then
  echo -e "  ${BOLD}Files on main:${NC}"
  curl -s "$GITEA_URL/api/v1/repos/$WORKSPACE_REPO/contents/" \
    -H "Authorization: token $GITEA_TOKEN" 2>/dev/null \
    | python3 -c "
import sys,json
for f in json.load(sys.stdin):
    print(f'    {f[\"name\"]}')
" 2>/dev/null || echo "    (empty)"
fi

echo ""
echo -e "${GREEN}${BOLD}Demo complete!${NC}"
echo ""
echo -e "  Repo:  ${CYAN}http://localhost:3000/$WORKSPACE_REPO${NC}"
echo -e "  Board: ${CYAN}http://localhost:5173${NC}"
echo -e "  Log:   ${CYAN}cat logs/worker.log${NC}"
echo ""
echo -e "  Stop: ${CYAN}docker compose down${NC}    Re-run: ${CYAN}./run-demo.sh${NC}"
