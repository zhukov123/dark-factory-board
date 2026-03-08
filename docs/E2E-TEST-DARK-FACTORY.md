# End-to-end test: Dark Factory with TaskBoard

This guide runs the full stack with a few test work items and verifies the worker processes them.

## Prerequisites

- .NET SDK (for TaskBoard API)
- Python 3.11+ and `pip` (for worker)
- One of:
  - **Temporal CLI**: [Install](https://docs.temporal.io/cli#install) then `temporal server start-dev`
  - **Docker**: `docker compose -f docker-compose.temporal.yml up -d`
- (Optional) LLM for LangGraph: **OpenRouter** (`OPENROUTER_API_KEY`) or **LM Studio** (`LMSTUDIO_BASE_URL=http://localhost:1234/v1`, `LMSTUDIO_MODEL`). If neither is set, ExecuteTaskWithLangGraph does a no-op and returns success.

## 1. Start Temporal

**Option A – Temporal CLI (single process, in-memory):**

```bash
temporal server start-dev
```

Leave this running. Default: frontend `localhost:7233`, Web UI `http://localhost:8233`.

**Option B – Docker (with Postgres):**

```bash
docker compose -f docker-compose.temporal.yml up -d
```

Wait a few seconds for Temporal to be ready.

---

## 2. Start TaskBoard API

In a **second terminal**:

```bash
cd /path/to/dark-factory-board
dotnet run --project TaskBoard.Api --urls "http://localhost:5005"
```

Or use the launch profile:

```bash
dotnet run --project TaskBoard.Api --launch-profile http
```

Use the URL shown (e.g. `http://localhost:5005`). Auth token in development is usually `dev-token` (see `appsettings.Development.json`).

Check:

```bash
curl -s http://localhost:5005/healthz
# {"ok":true}
```

---

## 3. Seed test tickets

In a **third terminal** (or same as step 2 after API is up):

```bash
cd /path/to/dark-factory-board
chmod +x scripts/seed-test-tickets.sh
./scripts/seed-test-tickets.sh http://localhost:5005 dev-token
```

You should see three tickets created and the output of `GET /tickets?status=Ready` and `GET /pick-next`. Note the ticket IDs (e.g. T1, T2, T3).

**Manual alternative (no script):**

```bash
TOKEN=dev-token
API=http://localhost:5005

curl -X POST "$API/tickets" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Add README section","status":"Ready","priority":1,"repo":"dark-factory-board","description":"Add API section to README."}'
```

---

## 4. Start the worker

In a **fourth terminal**:

```bash
cd /path/to/dark-factory-board/worker
pip install -r requirements.txt
export TASKBOARD_URL=http://localhost:5005
export TASKBOARD_TOKEN=dev-token
# Optional: real LLM
export OPENROUTER_API_KEY=sk-or-your-key
export OPENROUTER_MODEL=openai/gpt-4o-mini

python main.py
```

You should see logs like: `Connecting to Temporal at localhost:7233`, `Worker started on task queue dark-factory`. Leave it running.

---

## 5. Start a workflow

With the worker running, start one workflow so it picks tasks from the board.

**Option A – Temporal Web UI**

1. Open http://localhost:8233 (or the URL shown by `temporal server start-dev`).
2. Namespace: `default`.
3. **Workflows** → **Start Workflow**.
4. Workflow type: `DarkFactoryRun`, Task queue: `dark-factory`.
5. Input (JSON):

```json
{
  "owner": "worker-1",
  "ttl_seconds": 1800,
  "sleep_seconds_when_no_task": 60,
  "max_idle_seconds": 3600
}
```

6. Start. The worker will pick the first Ready ticket and run the pipeline.

**Option B – Temporal CLI**

```bash
temporal workflow start \
  --task-queue dark-factory \
  --type DarkFactoryRun \
  --input '{"owner":"worker-1","ttl_seconds":1800,"sleep_seconds_when_no_task":60,"max_idle_seconds":3600}'
```

---

## Where to watch progress and logs (besides TaskBoard)

| Where | What you see |
|-------|----------------|
| **Temporal Web UI** | Workflow runs, current step, full history. Open **http://localhost:8233** (with `temporal server start-dev`). Go to **Workflows** → select your run → **History** to see each activity (PickNextTask, ClaimTask, PrepareWorkspace, ExecuteTaskWithLangGraph, etc.) and workflow log messages. |
| **Worker terminal** | Live logs: connection, “Pick task”, “Claim”, activity start/complete, and any `workflow.logger.info` output (e.g. “No task eligible”, “Task closed”). Run `python main.py` in a terminal and leave it open. |
| **Temporal CLI** | List and inspect workflows from the shell: `temporal workflow list --task-queue dark-factory`, `temporal workflow show -w <WorkflowId>` to see status and history. |

TaskBoard still gives ticket status, run phase, attachments (`task_result.json`, `run_tests.log`), and `last_error`; use Temporal + worker for pipeline progress and execution logs.

---

## 6. What to verify

- **Worker logs**: Pick task → Claim → PrepareWorkspace → ExecuteTaskWithLangGraph → RunTaskTests → OpenOrUpdatePR → WaitForReviewAndCI → CloseTask. For a stub/no-GitHub run you may see failures or skips on clone/PR; the important part is claim → execute (or no-op) → close.
- **TaskBoard API**:
  - `GET /tickets` (or UI): first ticket moves **Ready → InProgress** when claimed, then to **Review** after “PR” step, then **Done** after close (when using stub “merged”).
  - `GET /tickets/{id}`: `run` has `phase`, `lock_owner` (cleared after release), and optionally `branch`, `pr_number`.
  - `GET /tickets/{id}/attachments`: after a run you may see `task_result.json` and/or `run_tests.log` if the activity uploaded them.
- **Temporal UI**: Workflow history shows activity tasks (PickNextTask, ClaimTask, PrepareWorkspace, ExecuteTaskWithLangGraph, RunTaskTests, OpenOrUpdatePR, WaitForReviewAndCI, CloseTask).

---

## 7. Run multiple tickets

The workflow loops: after closing one task it calls **pick-next** again. With three Ready tickets and `max_idle_seconds` large enough, the same workflow will process all three (one after another). To process only one and exit quickly, set e.g. `max_idle_seconds: 60` and start the workflow when at least one ticket is Ready; after that ticket is closed, when no task is eligible for 60 seconds the workflow exits.

---

## 8. Cleanup

- Stop worker: Ctrl+C in the worker terminal.
- Stop API: Ctrl+C in the API terminal.
- Stop Temporal: Ctrl+C in the `temporal server start-dev` terminal, or `docker compose -f docker-compose.temporal.yml down` if using Docker.
- To reset the board: delete or transition tickets via API/UI, or use a fresh DB by removing `taskboard.db` / `taskboard.dev.db` and restarting the API (tickets will be recreated by re-running the seed script).

---

## Troubleshooting

| Issue | Check |
|-------|--------|
| Worker: "Failed client connect" | Temporal not running or wrong host/port. Use `TEMPORAL_HOST=localhost:7233`. |
| Worker: "401" or "invalid token" | `TASKBOARD_TOKEN` must match API (e.g. `dev-token`). |
| Pick-next returns "none eligible" | Tickets must be **Ready** and have no unmet dependencies. Use seed script or create tickets with `status: Ready`. |
| ExecuteTaskWithLangGraph no-op | Without `OPENROUTER_API_KEY`, the runner returns success without calling the LLM. Set the key for real planner/implementer/reviewer steps. |
| OpenOrUpdatePR / clone fails | Set `GITHUB_TOKEN` and use a real `repo` (e.g. `owner/repo`). For a quick E2E test, stub behavior (no clone) still allows claim → execute → close. |
