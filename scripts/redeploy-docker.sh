#!/usr/bin/env bash
# Redeploy TaskBoard Docker image to server (preserves taskboard-data volume).
# Usage:
#   TASKBOARD_SERVER=user@192.168.1.182 ./scripts/redeploy-docker.sh
#   SSHPASS=yourpassword TASKBOARD_SERVER=user@host ./scripts/redeploy-docker.sh  # password auth via sshpass
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVER="${TASKBOARD_SERVER:?Set TASKBOARD_SERVER e.g. user@192.168.1.182}"
if [ -n "${SSHPASS:-}" ]; then
  command -v sshpass &>/dev/null || { echo "SSHPASS set but sshpass not installed. brew install sshpass (or install via your package manager)"; exit 1; }
  SSH_CMD="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
else
  SSH_CMD="ssh"
fi

echo "=== Building image (linux/amd64) ==="
docker build --platform linux/amd64 -t taskboard:latest .

echo "=== Sending image to $SERVER and redeploying (DB volume preserved) ==="
docker save taskboard:latest | gzip | $SSH_CMD "$SERVER" 'set -e
  gunzip | docker load
  docker stop taskboard 2>/dev/null || true
  docker rm taskboard 2>/dev/null || true
  docker run -d \
    --name taskboard \
    -p 5173:5173 \
    -e TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}" \
    -e TaskBoard__AuthToken="${TASKBOARD_TOKEN:-dev-token}" \
    -v taskboard-data:/data \
    --restart unless-stopped \
    taskboard:latest
  echo "Redeploy done."
'
echo "App URL: http://${SERVER#*@}:5173"
