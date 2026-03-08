# Analysis: Why Nothing Seemed to Work

## Observed state

- **T80** has been **InProgress** for hours (06:22 → 08:42+), **0/5** tickets Done.
- **Workspace**: `.dark-factory.json`, LangGraph checkpoint DB (`.langgraph_checkpoints.sqlite`), **no `src/`, no `package.json`**.
- **T80 run**: `branch: task/T80-T80`, `last_error: ""`, **no attachments** (no `task_result.json`, no `run_tests.log`).
- **Lock**: `lock_expires_at` is in the past → lock has expired; no worker is actively holding the run.

So: **prepare_workspace succeeded** (branch created, metadata written). **Execute (LangGraph) never completed successfully** (no attachments, no code). The run is effectively **stuck**.

---

## Root causes (why no code)

### 1. **LLM never ran or couldn’t be reached**

Code generation is done by LangGraph calling an LLM (Planner → Implementer → Reviewer). That only runs if **at least one** of these is set when the worker runs:

- `OPENROUTER_API_KEY`
- `LMSTUDIO_BASE_URL` (e.g. `http://localhost:1234/v1`)

If **neither** is set in the **worker process** env, `run_task()` takes the **no-op path**: it returns success immediately and writes a minimal `task_result.json` with `files_changed: []`. So **no files are created**.

If **LMSTUDIO_BASE_URL** (or OpenRouter) **is** set but **LM Studio (or OpenRouter) is not running**, the first LLM call (e.g. in the planner) will **fail** (connection refused / timeout). The **Execute** activity then **throws**. Temporal **retries** the activity (with backoff, up to 1h timeout per attempt). We **do not** write that failure to the run’s `last_error`, so the ticket still shows `last_error: ""` even though Execute is failing.

So in practice one or both of:

- Worker was started **without** `LMSTUDIO_BASE_URL` / `OPENROUTER_API_KEY` (e.g. different terminal, or script that didn’t export them) → no-op → no code, but then we’d expect run_tests and close_task to run and T80 to go Done. So this alone doesn’t explain “stuck InProgress”.
- Worker **had** `LMSTUDIO_BASE_URL` but **LM Studio was not running** → LLM calls fail → Execute activity throws → retries → we never set `last_error` → ticket stays InProgress with no code and no attachments. **This matches the observed state.**

### 2. **Execute failure is invisible on the ticket**

When `execute_task_with_lang_graph` throws (e.g. LLM connection error), we **do not** call `patch_run(ticket_id, last_error=...)`. So the run’s `last_error` stays empty and the ticket looks “fine” even though the activity is failing. That’s why “nothing seems to have worked” is hard to debug from the UI alone.

### 3. **Stuck run after workflow/activity failure**

When Execute eventually exhausts retries (or the workflow fails), the **workflow** can stop, but the **ticket** is never released or moved to Blocked. So T80 stays **InProgress** with an **expired lock**. No other workflow will pick it up until the run is released and the ticket is set back to Ready.

---

## What actually happened (most likely)

1. Workflow started, claimed **T80**, **prepare_workspace** ran and succeeded (subprocess git, branch `task/T80-T80`).
2. **Execute (LangGraph)** ran with `LMSTUDIO_BASE_URL` set but **LM Studio not running** (or not reachable).
3. First LLM call failed → activity threw → Temporal retried (possibly for a long time due to 1h timeout and backoff).
4. We never updated the run’s `last_error`, so the ticket still showed no error.
5. Eventually the activity/workflow failed; the ticket was never released or set to Blocked, so **T80 stayed InProgress** with no code and no attachments.

---

## Fixes applied / recommended

1. **Record Execute failures on the run**  
   In `execute_task_with_lang_graph`, wrap `run_task(...)` in try/except and on exception call `patch_run(ticket_id, last_error=str(e))` (then re-raise). So when the LLM is unreachable (or any other error in Execute), the ticket shows the real error.

2. **Ensure LLM is available when you want code**
   - Start **LM Studio**, load a model, start the local server (e.g. port 1234).
   - Or set **OPENROUTER_API_KEY** and use OpenRouter.
   - Start the **worker** in an environment where the chosen variable is set (e.g. `export LMSTUDIO_BASE_URL=http://localhost:1234/v1` then `python main.py`, or use `worker/.env` and run from the worker dir).

3. **Unstick the current run**
   - Release the run:  
     `POST /runs/release` with `{"ticket_id": "T80", "owner": "worker-1"}`.
   - Set ticket back to Ready:  
     `PATCH /tickets/T80` with `{"status": "Ready"}`.
   - Optionally terminate old workflows:  
     `python worker/terminate_old_workflows.py`.
   - Then start **one** worker (with LLM env) and **one** workflow (e.g. `./scripts/run-autonomous-cycle.sh`).

4. **Verify before relying on autonomy**
   - Confirm LM Studio (or OpenRouter) is up and reachable.
   - Confirm the worker logs show it connecting to the LLM (or that you see LLM traffic).
   - After a run, check the ticket’s **attachments** and **last_error**; if Execute failed, you’ll now see the error on the ticket.

---

## Summary

| What worked | What didn’t |
|-------------|-------------|
| TaskBoard, Temporal, worker process, workflow start, pick-next, claim, prepare_workspace (branch + metadata), LangGraph checkpoint DB created | Execute (LLM) never succeeded → no code, no `task_result`/attachments; failure not written to `last_error`; ticket left InProgress with expired lock |

**Bottom line:** The pipeline is wired correctly, but **no code was generated** because the LLM step either wasn’t configured in the worker env or wasn’t reachable (e.g. LM Studio not running). Execute’s failures weren’t written to the run, so the ticket looked “ok” while the run was actually stuck. Recording Execute errors and ensuring the LLM is running and configured in the worker env will make the system both work and debuggable.
