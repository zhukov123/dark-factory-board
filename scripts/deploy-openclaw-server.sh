#!/usr/bin/env bash
# Run this script ON the server where you are installing TaskBoard.
# Do not put SSH in scripts — SSH to the server manually, then run this script.
# Installs .NET + Node if needed, builds the app, runs it on 0.0.0.0:5173.
# Usage: ./scripts/deploy-openclaw-server.sh
# Optional: TASKBOARD_HOST=<server-ip-or-hostname> to show the remote URL in the summary.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT=5173
BIND=0.0.0.0

echo "=== TaskBoard deploy for OpenClaw server ==="

# --- .NET 9 (project targets net9.0) ---
if ! command -v dotnet &>/dev/null; then
  echo "Installing .NET SDK..."
  if command -v apt-get &>/dev/null && command -v lsb_release &>/dev/null; then
    UBUNTU_VERSION=$(lsb_release -rs)
    wget -q "https://packages.microsoft.com/config/ubuntu/${UBUNTU_VERSION}/packages-microsoft-prod.deb" -O /tmp/packages-microsoft-prod.deb
    sudo dpkg -i /tmp/packages-microsoft-prod.deb
    sudo apt-get update
    sudo apt-get install -y dotnet-sdk-9.0 || sudo apt-get install -y dotnet-sdk-8.0
  else
    echo "Please install .NET 9 (or 8) SDK: https://learn.microsoft.com/en-us/dotnet/core/install/linux"
    exit 1
  fi
fi
dotnet --version

# --- Node 20 (for building UI) ---
if ! command -v node &>/dev/null; then
  echo "Installing Node 20..."
  if command -v apt-get &>/dev/null && command -v curl &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "Please install Node 20+ and npm, then re-run this script"
    exit 1
  fi
fi
node -v
npm -v

# --- Build UI ---
echo "Building UI..."
cd "$ROOT/TaskBoard.Ui"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
npm run build

# --- Copy UI into API wwwroot ---
echo "Copying UI into API wwwroot..."
rm -rf "$ROOT/TaskBoard.Api/wwwroot"
mkdir -p "$ROOT/TaskBoard.Api/wwwroot"
cp -R dist/* "$ROOT/TaskBoard.Api/wwwroot/"

# --- Publish API ---
echo "Publishing API..."
cd "$ROOT/TaskBoard.Api"
dotnet publish -c Release -o "$ROOT/out"

# --- Run (bound to all interfaces; reachable at http://<host>:5173) ---
export ASPNETCORE_URLS="http://${BIND}:${PORT}"
export TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
export ASPNETCORE_ENVIRONMENT=Production

echo ""
echo "Starting TaskBoard on http://${BIND}:${PORT}"
echo "  Local:  http://localhost:${PORT}"
if [ -n "${TASKBOARD_HOST:-}" ]; then
  echo "  Remote: http://${TASKBOARD_HOST}:${PORT}"
else
  echo "  Remote: http://<host>:${PORT}  (set TASKBOARD_HOST to your server IP/hostname to see it here)"
fi
echo "  Token:  ${TASKBOARD_TOKEN}"
echo ""
echo "Press Ctrl+C to stop. To run in background: nohup ./out/TaskBoard.Api &"
echo ""

if [ "${TASKBOARD_BACKGROUND:-0}" = "1" ]; then
  nohup "$ROOT/out/TaskBoard.Api" > "$ROOT/taskboard.log" 2>&1 &
  echo "TaskBoard started in background. Log: $ROOT/taskboard.log"
  exit 0
fi

exec "$ROOT/out/TaskBoard.Api"
