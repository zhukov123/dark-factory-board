#!/usr/bin/env bash
# Count LLM interactions from logs written by the worker (LLMLogHandler).
# Each file in logs/llm/*.md = one LLM call (on_llm_start/on_llm_end).
# Usage: ./scripts/count-llm-calls.sh [logs_dir]
# Default logs_dir: $REPO_ROOT/logs/llm (or worker/logs/llm if run from worker).

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="${1:-$REPO_ROOT/logs/llm}"

if [ ! -d "$LOGS_DIR" ]; then
  echo "Logs dir not found: $LOGS_DIR"
  echo "Run the worker at least once so it creates logs/llm/*.md (and ensure logs/ is not deleted)."
  exit 1
fi

COUNT=$(find "$LOGS_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
echo "LLM interactions (one file = one call): $COUNT"

# Optional: breakdown by step (planner, implementer, reviewer) from filename pattern
if [ "$COUNT" -gt 0 ]; then
  echo ""
  echo "By step (from filename):"
  for step in planner implementer reviewer; do
    N=$(find "$LOGS_DIR" -name "*_${step}_*.md" 2>/dev/null | wc -l | tr -d ' ')
    echo "  $step: $N"
  done
fi
