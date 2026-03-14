#!/bin/sh
# Start the Temporal worker in the background, then start one workflow, then wait on the worker.
set -e
# So prepare_workspace can run git checkout; one task at a time in /workspace
if [ ! -d /workspace/.git ]; then
  git init /workspace && git -C /workspace config user.email "worker@local" && git -C /workspace config user.name "Worker"
fi
python main.py &
PID=$!
sleep 5
python start_workflow.py || true
wait $PID
