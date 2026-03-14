# Dark Factory Worker

Python Temporal worker that runs the DarkFactoryRun workflow: pick task → claim → prepare workspace → execute (LangGraph: planner + implementer) → tests → open PR → review PR (Reviewer LLM reviews the PR description and diff, posts review) → merge or re-run implementer on feedback → close.

## Setup

- Python 3.11+
- Temporal server (e.g. [Temporal CLI](https://docs.temporal.io/cli) dev server: `temporal server start-dev`)

```bash
cd worker
pip install -r requirements.txt
```

## Environment

| Variable | Description |
|----------|-------------|
| TASKBOARD_URL | TaskBoard API base URL (default: http://localhost:5000) |
| TASKBOARD_TOKEN | Bearer token for API |
| GITHUB_TOKEN | For clone and PR/checks (Phase C+) |
| REPO_CLONE_ROOT | Directory for cloning repos (default: /tmp/dark-factory-workspaces) |
| WORKSPACE_REPO | When set, this repo is used as the workspace for all tasks: clone and PR target (e.g. `owner/my-repo` or `https://github.com/owner/my-repo.git`). Overrides workflow/ticket repo. |
| WORKSPACE_PATH | When set, this local directory is used as the workspace (no clone). All code changes happen here. One task at a time (e.g. `/Users/you/Code/GitHub/factory-workspace-1`). |
| TEMPORAL_HOST | Temporal frontend (default: localhost:7233) |
| TEMPORAL_TASK_QUEUE | Task queue name (default: dark-factory) |
| SLEEP_SECONDS_WHEN_NO_TASK | Sleep when no eligible task (default: 300) |
| MAX_IDLE_SECONDS | Exit after this many seconds with no task (optional) |
| OPENROUTER_API_KEY | OpenRouter API key (for LangGraph LLM). Get one at https://openrouter.ai/settings/keys |
| OPENROUTER_MODEL | OpenRouter model id (default: `minimax/minimax-m2.5`). Override with e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4` |
| LMSTUDIO_BASE_URL | Local OpenAI-compatible server URL (e.g. `http://localhost:1234/v1`). Server must expose `/v1/chat/completions` and `/v1/models`. If set and OPENROUTER_API_KEY is not set, LangGraph uses this. |
| LMSTUDIO_MODEL | Model name as shown by the server (default: `local`). Must match a model returned by `/v1/models`. |

## Run worker

```bash
python main.py
```

**Watching progress:** Worker stdout shows live logs. For pipeline steps and history, use the **Temporal Web UI** (e.g. http://localhost:8080) or `temporal workflow list` / `temporal workflow show -w <id>`. See [E2E guide](../docs/E2E-TEST-DARK-FACTORY.md) for details.

**Stopping old workflows:** To avoid multiple workflows competing for the same tickets, run `python terminate_old_workflows.py` (terminates all) or `python terminate_old_workflows.py --keep-latest` (keeps only the most recent). Then release any stuck ticket and start a fresh workflow if needed.

## Start a workflow (test)

With Temporal CLI and a running worker:

```bash
temporal workflow start \
  --task-queue dark-factory \
  --type DarkFactoryRun \
  --input '{"owner":"worker-1","ttl_seconds":1800,"sleep_seconds_when_no_task":60}'
```

Or use the Temporal UI (default http://localhost:8233) to start a workflow.

## End-to-end test

For a full E2E run with TaskBoard and test work items, see **[docs/E2E-TEST-DARK-FACTORY.md](../docs/E2E-TEST-DARK-FACTORY.md)**. Summary:

1. Start Temporal (`temporal server start-dev` or Docker).
2. Start TaskBoard API (`dotnet run --project TaskBoard.Api --urls "http://localhost:5005"`).
3. Seed test tickets: `./scripts/seed-test-tickets.sh http://localhost:5005 dev-token`.
4. Run worker: `TASKBOARD_URL=http://localhost:5005 TASKBOARD_TOKEN=dev-token python main.py`.
5. Start a workflow (Temporal UI or CLI); worker will pick tasks and run the pipeline.
6. Verify tickets move Ready → InProgress → … → Done and attachments appear.
