#!/bin/sh
# Terminate any existing DarkFactoryRun workflows (from previous container restarts), then start
# the worker and a single new workflow. Temporal state persists across restarts; we avoid
# accumulating multiple running workflows.
set -e
# So prepare_workspace can run git checkout; one task at a time in /workspace
if [ ! -d /workspace/.git ]; then
  git init /workspace && git -C /workspace config user.email "worker@local" && git -C /workspace config user.name "Worker"
fi
# Clean up workflows from previous runs (Temporal container is not restarted with taskboard reset)
python terminate_old_workflows.py 2>/dev/null || true
python main.py &
PID=$!
sleep 5
python start_workflow.py || true
wait $PID
