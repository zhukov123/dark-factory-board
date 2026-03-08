# Autonomous run: Dark Factory

This guide gets the worker to process all task-manager stories (T80–T84) and produce code in your workspace with minimal manual steps.

## Prerequisites

1. **TaskBoard API** running (e.g. `dotnet run --project TaskBoard.Api --launch-profile http`).
2. **Temporal** running (Docker: `docker compose -f docker-compose.temporal.yml up -d`).
3. **LM Studio** (or OpenRouter) for code generation:
   - Start LM Studio, load a model, start the local server (e.g. port 1234).
   - Or set `OPENROUTER_API_KEY` and leave `LMSTUDIO_BASE_URL` unset.
4. **Workspace folder**: a git repo (can be empty or have a `main` branch). All generated code will go here.

## One-time setup

```bash
cd worker
cp .env.example .env
# Edit .env: WORKSPACE_PATH, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL, TASKBOARD_URL, TASKBOARD_TOKEN, SKIP_PR=1
pip install -r requirements.txt
```

## Run one cycle (one workflow, processes tickets in order)

From the repo root:

```bash
./scripts/run-autonomous-cycle.sh
```

Or manually:

```bash
cd worker
# 1. Stop any old worker
pkill -f "python main.py" || true
sleep 2

# 2. Terminate old workflows (so only one run processes tickets)
python terminate_old_workflows.py

# 3. Release stuck ticket and set to Ready (if T80 was InProgress)
curl -s -X POST "http://localhost:5005/runs/release" -H "Authorization: Bearer $TASKBOARD_TOKEN" -H "Content-Type: application/json" -d '{"ticket_id":"T80","owner":"worker-1"}'
curl -s -X PATCH "http://localhost:5005/tickets/T80" -H "Authorization: Bearer $TASKBOARD_TOKEN" -H "Content-Type: application/json" -d '{"status":"Ready"}'

# 4. Start worker (in background or another terminal)
export TASKBOARD_URL=http://localhost:5005 TASKBOARD_TOKEN=dev-token
export WORKSPACE_PATH=/path/to/your/workspace
export LMSTUDIO_BASE_URL=http://localhost:1234/v1 LMSTUDIO_MODEL=qwen/qwen3.5-9b
export SKIP_PR=1
python main.py &

# 5. Start one workflow
python start_workflow.py
```

## Monitor

- **Tickets**: `curl -s -H "Authorization: Bearer dev-token" "http://localhost:5005/tickets?limit=10"`
- **Workspace**: `ls $WORKSPACE_PATH` — look for `src/`, `package.json` after T80 completes.
- **Temporal UI**: http://localhost:8080 — workflow history and activity status.
- **Worker logs**: stdout of `python main.py`.

## When things get stuck

- **T80 InProgress, no code**: Ensure LM Studio (or OpenRouter) is running and reachable; worker must have `LMSTUDIO_BASE_URL` or `OPENROUTER_API_KEY` set.
- **LM Studio on another host**: Set `LMSTUDIO_BASE_URL=http://192.168.1.254:1234/v1` (or your host) in `.env` or when starting the worker; the script default is `192.168.1.254`.
- **400 on PATCH /runs/T80**: The API expects run phase `AwaitingApproval` (PascalCase), not `awaiting_approval`; the worker uses the correct value.
- **"No item found with id 'origin'"**: Prepare workspace now uses subprocess `git` for WORKSPACE_PATH; ensure the workspace dir is a git repo with at least one commit (e.g. `git init && git commit --allow-empty -m init`).
- **Multiple workflows**: Run `python terminate_old_workflows.py`, release the ticket, set to Ready, start one workflow.

## Success

When all five stories (T80–T84) are **Done** and the workspace contains a React app (`package.json`, `src/`, `npm run dev` works), the autonomous setup is working.
