#!/usr/bin/env bash
# Wait for Gitea, create admin user, API token, and E2E repo; append GITEA_URL, GITEA_TOKEN, WORKSPACE_REPO to .env.e2e.
# Usage: ./scripts/gitea_bootstrap.sh [GITEA_URL] [COMPOSE_PROJECT_NAME]
# Requires: Gitea running (e.g. docker compose up -d gitea). Writes to repo-root .env.e2e.

set -e
GITEA_URL="${1:-http://localhost:3000}"
COMPOSE_PROJECT_NAME="${2:-dark-factory-board}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.e2e"
ADMIN_USER="${GITEA_ADMIN_USER:-gitea}"
ADMIN_PASS="${GITEA_ADMIN_PASSWORD:-gitea}"
REPO_NAME="${GITEA_E2E_REPO_NAME:-e2e-workspace}"

echo "Gitea bootstrap: $GITEA_URL -> $ENV_FILE"

# Wait for Gitea to respond
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" "$GITEA_URL/api/healthz" 2>/dev/null | grep -q 200; then
    echo "Gitea is up."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Gitea did not become ready in time."
    exit 1
  fi
  sleep 2
done

# Create admin user if not exists (idempotent)
CONTAINER=$(docker ps -q -f "ancestor=gitea/gitea" 2>/dev/null | head -1)
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps -q -f "name=${COMPOSE_PROJECT_NAME}-gitea" 2>/dev/null | head -1)
fi
if [ -n "$CONTAINER" ]; then
  # Run as git user (Gitea container default) to avoid "not supposed to be run as root"
  docker exec -u git "$CONTAINER" gitea admin user create \
    --username "$ADMIN_USER" \
    --password "$ADMIN_PASS" \
    --email "${ADMIN_USER}@local" \
    --admin \
    --must-change-password=false 2>/dev/null || true
fi

# Create API token
TOKEN_RESP=$(curl -s -X POST "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens" \
  -u "$ADMIN_USER:$ADMIN_PASS" \
  -H "Content-Type: application/json" \
  -d '{"name":"e2e","scopes":["all"]}')
GITEA_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha1',''))" 2>/dev/null)
if [ -z "$GITEA_TOKEN" ]; then
  echo "Failed to create Gitea token. Response: $TOKEN_RESP"
  exit 1
fi

# Create repo (owner = admin user)
CREATE_RESP=$(curl -s -X POST "$GITEA_URL/api/v1/user/repos" \
  -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$REPO_NAME\",\"private\":true}")
if echo "$CREATE_RESP" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo "Repo $ADMIN_USER/$REPO_NAME created or already exists."
else
  echo "Create repo response: $CREATE_RESP"
fi

WORKSPACE_REPO="$ADMIN_USER/$REPO_NAME"

# Append to .env.e2e (avoid duplicates)
if [ -f "$ENV_FILE" ]; then
  # Remove old Gitea vars if present
  grep -v "^GITEA_URL=" "$ENV_FILE" | grep -v "^GITEA_TOKEN=" | grep -v "^WORKSPACE_REPO=" > "${ENV_FILE}.tmp" || true
  mv "${ENV_FILE}.tmp" "$ENV_FILE"
fi
echo "" >> "$ENV_FILE"
echo "# Gitea E2E (from gitea_bootstrap.sh)" >> "$ENV_FILE"
echo "GITEA_URL=$GITEA_URL" >> "$ENV_FILE"
echo "GITEA_TOKEN=$GITEA_TOKEN" >> "$ENV_FILE"
echo "WORKSPACE_REPO=$WORKSPACE_REPO" >> "$ENV_FILE"

echo "Bootstrap done. Appended to $ENV_FILE:"
echo "  GITEA_URL=$GITEA_URL"
echo "  GITEA_TOKEN=***"
echo "  WORKSPACE_REPO=$WORKSPACE_REPO"
echo "Run: set -a && source .env.e2e && set +a"
