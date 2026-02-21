#!/usr/bin/env bash
# Stop any existing TaskBoard API (port 5005) and UI dev server (ports 5173–5175), then start both.
# Usage: ./scripts/run-dev.sh   (from repo root or any dir)

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_PORT=5005
VITE_PORTS="5173 5174 5175"
API_PID=""
UI_PID=""

cleanup() {
  echo ""
  echo "Stopping API and UI..."
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "Stopping existing instances..."

for port in $API_PORT $VITE_PORTS; do
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  Killing process(es) on port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

sleep 2

echo "Starting API on http://localhost:$API_PORT ..."
cd "$ROOT"
dotnet run --project TaskBoard.Api --launch-profile http &
API_PID=$!

sleep 3

echo "Starting UI dev server..."
cd "$ROOT/TaskBoard.Ui"
npm run dev &
UI_PID=$!

echo ""
echo "TaskBoard is running:"
echo "  API: http://localhost:$API_PORT"
echo "  UI:  http://localhost:5173 (or the port Vite prints above)"
echo ""
echo "API PID: $API_PID  |  UI PID: $UI_PID"
echo "To stop: kill $API_PID $UI_PID"
echo ""

wait
