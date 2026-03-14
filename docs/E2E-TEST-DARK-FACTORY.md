# E2E test: Dark Factory (2-ticket flow with Gitea)

This runbook gets the **2-ticket E2E** passing: Gitea → bootstrap → TaskBoard + Temporal → seed 2 stories → worker runs both stories (scaffold API, then CRUD), opens PRs, posts reviewer-persona review, merges when pass, closes tickets.

## Prerequisites

- Docker (for Gitea, TaskBoard, Temporal)
- Python 3.11+ with worker deps (`pip install -r worker/requirements.txt`)
- `.env.e2e` with at least `OPENROUTER_API_KEY` (bootstrap will add Gitea vars)

## 1. Start Gitea

```bash
docker compose up -d gitea
```

Wait until healthy (or ~30s). Gitea: http://localhost:3000

## 2. Bootstrap Gitea (create admin, token, repo)

```bash
./scripts/gitea_bootstrap.sh
```

This appends `GITEA_URL`, `GITEA_TOKEN`, `WORKSPACE_REPO` to `.env.e2e`.

## 3. Load env and check

```bash
set -a && source .env.e2e && set +a
./scripts/check-e2e-env.sh
```

Set `TASKBOARD_URL` and `TASKBOARD_TOKEN` if not in `.env.e2e` (e.g. `TASKBOARD_URL=http://localhost:5173`, `TASKBOARD_TOKEN=dev-token`).

## 4. Start TaskBoard and Temporal (do not start the worker in Docker)

```bash
docker compose up -d taskboard temporal temporal-ui gitea
# Do NOT run: docker compose up -d worker
# The in-container worker uses SKIP_PR=1 and would close tickets without opening PRs.
# For this E2E you run the worker locally with SKIP_PR=0 (see step 6).
```

- TaskBoard (API + UI): http://localhost:5173  
- Temporal Web UI: http://localhost:8080  

## 5. Seed the 2 E2E stories

```bash
set -a && source .env.e2e && set +a
export TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5173}"
export TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
./scripts/seed-e2e-stories.sh
```

Story 1 (scaffold FastAPI task API) and Story 2 (CRUD) are created; Story 2 is blocked by Story 1.

## 6. Run the worker (local, with Gitea + PR flow)

From repo root, with **PR creation and merge** (set `SKIP_PR=0`). Run from **worker** directory so imports resolve:

```bash
set -a && source .env.e2e && set +a
export TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5173}"
export TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
export TEMPORAL_HOST="${TEMPORAL_HOST:-localhost:7233}"
export SKIP_PR=0
cd worker && python main.py
```

Worker will: pick Story 1 → prepare workspace (clone from Gitea) → execute (LangGraph) → tests → open PR → post review → merge → close → pick Story 2 → same flow → done.

## 7. Start the workflow

In another terminal:

```bash
cd worker && python start_workflow.py
```

Or via Temporal CLI: `temporal workflow start --task-queue dark-factory --type DarkFactoryRun`.

## 8. Run the verifier (required to confirm E2E pass)

In a third terminal, after starting the workflow, run the verification script. It polls TaskBoard until both tickets are **Done** (timeout 35 min), then checks that each run has **pr_url** or **pr_number** and that the Gitea repo has commits. Exit 0 = E2E passed.

```bash
set -a && source .env.e2e && set +a
export TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5173}"
export TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
./scripts/verify-e2e.sh
```

(Ticket IDs are read from `.e2e-ticket-ids` written by `seed-e2e-stories.sh`. Or pass them: `./scripts/verify-e2e.sh T3 T4`.)

**The 2-ticket E2E is only “passed” when this verifier exits 0.**

## 9. Manual verify (optional)

- TaskBoard UI: open each ticket → Run State → **Open PR** link.
- Gitea: http://localhost:3000/gitea/e2e-workspace/pulls and repo commits.

**Expected duration:** Allow **20–40 minutes** for the 2-ticket run (each ticket: clone, LangGraph/LLM execute, tests, push, create PR, review, merge). Worker logs `Prepare workspace started/finished` and `Execute (LangGraph) started/finished` for each ticket so you can see progress.

**Empty Gitea repo:** The worker now handles an empty repo (no refs): it creates an orphan branch and an initial commit so it can push. No manual “initial commit” in Gitea is required.

**Single workflow:** Before starting, run `cd worker && python terminate_old_workflows.py` (no `--keep-latest`) so only one workflow runs; otherwise multiple workflows poll pick-next and can confuse the run.

## Token scope

- **Gitea token:** Created by bootstrap with repo scope (clone, push, create PR, create review, merge).
- **GitHub (optional):** Token needs Contents, Pull requests (read/write), and **merge** permission.

## Troubleshooting

- **Gitea not ready:** Increase wait in `gitea_bootstrap.sh` or run `docker compose logs gitea`.
- **Worker “Push failed”:** Ensure `GITEA_URL` is reachable from the worker (use `localhost:3000` when worker runs on host).
- **Migration:** TaskBoard applies migrations on startup; `pr_url` is added automatically.
