# Dark Factory — Execution Plan (LLM Agent One-Shot Spec)

This document is the **single source of truth** for implementing the full dark factory. Follow the phases in order. Every decision is already made; there are no open options. Validate at each checkpoint before proceeding.

---

## 1. Tech stack (pinned)

| Component | Choice |
|-----------|--------|
| TaskBoard API | Existing .NET 8 (TaskBoard.Api). Add new routes and entities here. |
| Worker | **Python 3.11+**. Temporal Python SDK, LangGraph, Git (GitPython or subprocess), HTTP client for TaskBoard API. |
| Temporal | Self-hosted Temporal server; persistence **Postgres**. |
| LangGraph | Python `langgraph`; use a checkpointer (e.g. `SqliteSaver` or Postgres) for resumability and human-approval interrupt. |
| Git host | **GitHub** (worker uses GitHub API for PR + checks; clone via HTTPS or SSH). |

---

## 2. Repository layout

- **TaskBoard.Api** — Add: new endpoints (claim, release, attachments, approve, reject), new Run phase `AwaitingApproval`, Run field `PendingApprovalDecisionId`, Attachment entity + table. No new project.
- **Worker** — New directory at repo root: `worker/`. Contents: `main.py`, workflow + activities, TaskBoard client, LangGraph graph, config (env). Single process: Temporal worker loop.
- **Temporal** — Run via Docker Compose or existing deployment; Postgres for Temporal persistence. Not part of this repo; document how to run it (or add `docker-compose.temporal.yml`).

---

## 3. API contracts (exact)

All request/response bodies JSON, **snake_case**. Auth: `Authorization: Bearer <token>` on every request except health and (optionally) attachment download.

### 3.1 POST /runs/claim

**Request:**
```json
{ "ticket_id": "T1", "owner": "worker-1", "ttl_seconds": 1800 }
```

**Success (200):** `{ "claimed": true, "run": { <run_dto> } }`  
**Failure (409):** ticket not Ready, or lock held by another owner. Body: `{ "claimed": false, "error": "..." }`.  
**404:** ticket not found.

**Server behavior:** In one transaction: (1) ensure ticket exists and status is Ready, (2) if run exists and lock is held by another and not expired, return 409; (3) create or update run: set lock_owner, lock_expires_at, phase = Plan; (4) set ticket status = InProgress; (5) save. Return run DTO.

### 3.2 POST /runs/release

**Request:**
```json
{ "ticket_id": "T1", "owner": "worker-1" }
```

**Success (200):** `{ "released": true }`. Clear lock_owner and lock_expires_at for that run only if current owner matches.  
**409:** lock not held by this owner or already expired.  
**404:** ticket or run not found.

### 3.3 Ticket attachments (new)

**POST /tickets/{id}/attachments**  
- Body: multipart form or JSON with base64 content. Use: `name` (e.g. `task_result.json`, `run.log`), optional `content_type`, and file content (or base64 `content`).
- Response 201: `{ "id": "<attachment_id>", "ticket_id": "T1", "name": "...", "size": 1234, "created_at": "..." }`.
- Store under TaskBoard (e.g. SQLite blob or file under a known dir; or new table with blob/location). Key by ticket_id + id.

**GET /tickets/{id}/attachments**  
- Response 200: `{ "items": [ { "id", "name", "size", "created_at" } ] }`.

**GET /tickets/{id}/attachments/{attachmentId}**  
- Response 200: file bytes (or redirect). Headers: Content-Type, Content-Disposition.

### 3.4 POST /runs/{ticketId}/approve and POST /runs/{ticketId}/reject

**Body:** `{ "decision_id": "uuid", "note": "optional" }`.

**Behavior:** Verify run exists, run.pending_approval_decision_id matches, phase is AwaitingApproval. Record decision (e.g. event or run field). **Signal the Temporal workflow** for that ticket’s run (workflow id must be known; e.g. `DarkFactoryRun-{ticket_id}` or stored in run). Return 200. Do not change ticket status here; the workflow will move it back to InProgress and resume.

**Implementation note:** The worker must register workflow id with the run when it blocks for approval (e.g. PATCH run with `workflow_id` or store in a small side table ticket_id → workflow_id). The API then calls Temporal’s SignalWorkflow (via Temporal client in-process or a small internal call). If the API cannot call Temporal directly, alternative: API writes “approval” event; worker polls or uses a separate “approval queue” the worker subscribes to. **Chosen:** API holds a Temporal client (or connects to Temporal) and signals the workflow by workflow id. Workflow id convention: `DarkFactoryRun-{ticket_id}-{run_attempt}`.

### 3.5 Run model changes

- **RunPhase:** Add `AwaitingApproval` (after `Integrate` or in a sensible order).
- **RunEntity:** Add `PendingApprovalDecisionId` (string, nullable). Optional: `WorkflowId` (string, nullable) so the API can signal the correct workflow.

---

## 4. Task spec (worker-built Markdown)

The worker builds a single Markdown string from the ticket and passes it to LangGraph. Template:

```markdown
# {title}
Repo: {repo}
Labels: {labels}

## Description
{description}

## Acceptance criteria
{acceptance_criteria, one per line}

## Test plan
{test_plan}
```

Use this exact schema so the LLM in LangGraph sees Purpose (title/description), Scope (repo/labels), Must-have (acceptance_criteria), Tests (test_plan). No spec_ref; no API change.

---

## 5. Workflow: DarkFactoryRun (Temporal)

- **Workflow id:** `DarkFactoryRun-{ticket_id}-{run_attempt}` (or single run per ticket: `DarkFactoryRun-{ticket_id}`). Uniqueness per “program run” is up to you; typically one workflow instance per ticket that is currently being worked on.
- **Input (workflow start):** `{ "repo": "optional filter", "owner": "worker-1", "ttl_seconds": 1800, "sleep_seconds_when_no_task": 300, "max_idle_seconds": null }`. `max_idle_seconds`: optional; if set, exit after that many seconds with no task claimed. `null` = run until explicitly cancelled.
- **Loop:**
  1. **PickNextTask** (activity). Input: repo, owner. Output: `{ "ticket_id": "T1", "task_spec": "# Markdown..." }` or `{ "ticket_id": null, "reason": "none eligible" }`.
  2. If `ticket_id` is null: sleep `sleep_seconds_when_no_task` (use Temporal timer); if `max_idle_seconds` exceeded, exit; else go to 1.
  3. **ClaimTask** (activity). Input: ticket_id, owner, ttl_seconds. Output: success or failure. On failure, go to 1.
  4. **PrepareWorkspace** (activity). Input: ticket_id, task_spec, repo. Output: workspace_path, branch. Clone repo (or use shared root); create branch `task/{ticket_id_slug}-{short_id}`; write metadata file; PATCH run (branch); POST ticket update.
  5. **ExecuteTaskWithLangGraph** (activity). Input: ticket_id, task_spec, workspace_path, branch. Output: `{ "success": true }` or `{ "success": false, "needs_approval": true, "decision_id": "..." }` or `{ "success": false, "error": "..." }`. If `needs_approval`: workflow waits for signal `Approve(decision_id)` or `Reject(decision_id)`; then re-call ExecuteTaskWithLangGraph (resume from checkpoint) or transition to Blocked and exit loop for this task.
  6. **RunTaskTests** (activity). Input: ticket_id, workspace_path. Output: success/failure, log excerpt. On failure: optionally re-enter ExecuteTaskWithLangGraph once or transition to Blocked.
  7. **OpenOrUpdatePR** (activity). Input: ticket_id, workspace_path, branch. Output: pr_url, pr_number. PATCH run; POST ticket update; upload artifacts (task_result.json, logs) via POST /tickets/{id}/attachments.
  8. **WaitForReviewAndCI** (activity). Input: ticket_id, pr_number, repo. Poll GitHub PR + checks. Output: `merged` | `changes_requested` | `rejected`. If `changes_requested`: transition to InProgress; go to 5 (re-run ExecuteTaskWithLangGraph with reviewer feedback in context). If `rejected`: transition to Blocked; release lock; go to 1. If `merged`: go to 9.
  9. **CloseTask** (activity). Input: ticket_id, owner. POST /runs/release; transition ticket to Done; POST final update. Go to 1.

---

## 6. Activity I/O summary

| Activity | Input | Output |
|----------|--------|--------|
| PickNextTask | repo?, owner | { ticket_id?, task_spec? } or { ticket_id: null, reason } |
| ClaimTask | ticket_id, owner, ttl_seconds | claimed: bool |
| PrepareWorkspace | ticket_id, task_spec, repo | workspace_path, branch |
| ExecuteTaskWithLangGraph | ticket_id, task_spec, workspace_path, branch | success, needs_approval?, decision_id?, error? |
| RunTaskTests | ticket_id, workspace_path | success, log_excerpt? |
| OpenOrUpdatePR | ticket_id, workspace_path, branch | pr_url, pr_number |
| WaitForReviewAndCI | ticket_id, pr_number, repo | merged \| changes_requested \| rejected |
| CloseTask | ticket_id, owner | void |

---

## 7. LangGraph graph (inside ExecuteTaskWithLangGraph)

- **Nodes:** Planner → Implementer → Reviewer. Edges: Planner→Implementer→Reviewer→(pass→end, fail→Implementer). Implementer has tools: read_file, write_file, run_command (for lint/test). Reviewer checks task spec criteria; if “risky” decision, trigger **interrupt** with decision_id and memo.
- **State:** Include task_spec, workspace_path, checklist (from Planner), current_file_edits, reviewer_feedback (when re-entering after “changes requested”), and interrupt decision_id when blocked.
- **Checkpointer:** Required. On interrupt, persist state; return needs_approval + decision_id to activity; activity sets ticket Blocked, phase AwaitingApproval, pending_approval_decision_id; workflow waits for signal; on Approve, activity resumes graph from checkpoint with approved choice.
- **Output:** Write `task_result.json` in workspace (assumptions, files changed, tests run, pass/fail). Activity uploads it to ticket attachments.

---

## 8. Implementation phases (do in this order)

### Phase A — TaskBoard API changes

1. Add `AwaitingApproval` to `RunPhase` enum. Add `PendingApprovalDecisionId` (and optionally `WorkflowId`) to `RunEntity`; migration.
2. Implement `POST /runs/claim` (contract in §3.1).
3. Implement `POST /runs/release` (contract in §3.2).
4. Add Attachment entity (TicketId, Name, ContentType, Size, StoragePath or Blob); migration. Implement POST/GET /tickets/{id}/attachments (upload, list, download) per §3.3.
5. Implement `POST /runs/{ticketId}/approve` and `POST /runs/{ticketId}/reject` per §3.4. If API cannot call Temporal directly, document: “Worker polls for approval events” and implement a GET or queue the worker will poll; otherwise add Temporal client to API and signal workflow by WorkflowId stored on run.

**Checkpoint A:** Run TaskBoard tests. Call POST /runs/claim, then POST /runs/release with Postman or curl; verify ticket transitions. Upload an attachment and GET list/download.

### Phase B — Worker skeleton (no LangGraph)

1. Create `worker/` directory. Python: temporalio, requests (or httpx). Config: TASKBOARD_URL, TASKBOARD_TOKEN, GITHUB_TOKEN, REPO_CLONE_ROOT, TEMPORAL_TASK_QUEUE, TEMPORAL_HOST.
2. TaskBoard client: functions for get_pick_next, claim, release, patch_run, transition, post_update, post_event, upload_attachment, get_ticket, list_attachments. Use snake_case request/response.
3. Implement activities: PickNextTask (call GET /pick-next, build task_spec from ticket), ClaimTask (POST /runs/claim), CloseTask (POST /runs/release + transition Done). Stub: PrepareWorkspace (return fixed path + branch), ExecuteTaskWithLangGraph (return success), RunTaskTests (return success), OpenOrUpdatePR (return stub), WaitForReviewAndCI (return merged).
4. Implement DarkFactoryRun workflow: loop PickNextTask → ClaimTask → [stub activities] → CloseTask; when no task, sleep 300s then retry; support max_idle_seconds.
5. Register workflow and activities with Temporal worker; run worker. Start a workflow with a test repo that has one Ready ticket; verify claim → close → release and ticket in Done.

**Checkpoint B:** One full stub run: pick task, claim, (stub work), close, release. Ticket moves Ready→InProgress→Done.

### Phase C — PrepareWorkspace + Git

1. PrepareWorkspace: clone repo (from config or ticket.repo) into REPO_CLONE_ROOT/ticket_{id}; create branch `task/{ticket_id}-{slug}`; write metadata file (ticket_id, branch, base_commit); PATCH run with branch; POST ticket update.
2. Use GitPython or subprocess for clone, branch, push. Require GITHUB_TOKEN and repo URL in config or ticket.

**Checkpoint C:** Run workflow; verify clone and branch exist; run metadata file present.

### Phase D — LangGraph (ExecuteTaskWithLangGraph)

1. Implement graph: Planner (LLM) → checklist; Implementer (tools: read_file, write_file, run_command) → edits; Reviewer (LLM) → pass or punch list; on “risky” → interrupt with decision_id.
2. Checkpointer (SqliteSaver in workspace or Postgres). On interrupt, activity returns needs_approval + decision_id; workflow waits for signal; store workflow_id on run when blocking so API can signal.
3. Activity: run graph; on interrupt, set ticket Blocked, phase AwaitingApproval, pending_approval_decision_id; return to workflow; on signal, resume graph from checkpoint.
4. Write task_result.json; upload via TaskBoard attachments. Post checklist as ticket update after Planner.

**Checkpoint D:** Run with a trivial task spec; verify checklist and task_result.json; test interrupt (if possible) and signal resume.

### Phase E — RunTaskTests + OpenOrUpdatePR

1. RunTaskTests: run project tests (e.g. `pytest`, `dotnet test`, or per-repo script); capture stdout/stderr; upload log as attachment; return success/failure.
2. OpenOrUpdatePR: push branch; create PR via GitHub API (title, body from task_result summary); PATCH run (pr_number); transition ticket to Review; upload task_result.json and log as attachments.

**Checkpoint E:** Full flow to PR created; ticket in Review; attachments visible.

### Phase F — WaitForReviewAndCI + CloseTask

1. WaitForReviewAndCI: poll GitHub PR state and checks (e.g. every 60s). merged → return merged; changes_requested → return changes_requested (and fetch review body for re-entry); rejected → return rejected. PATCH run (last_ci_state) when checks complete.
2. On changes_requested: transition ticket to InProgress; call ExecuteTaskWithLangGraph again with reviewer_feedback in state; then RunTaskTests → OpenOrUpdatePR → WaitForReviewAndCI (loop until merged or rejected).
3. CloseTask: POST /runs/release; transition to Done; post final update with merge commit and CI summary.

**Checkpoint F:** Full E2E: Ready → InProgress → (LangGraph + tests + PR) → Review → (poll) → merged → Done; release called.

### Phase G — Human approval wiring

1. API: approve/reject endpoints signal Temporal workflow (workflow_id from run). Store workflow_id on run when ExecuteTaskWithLangGraph first blocks for approval.
2. Worker: when graph interrupts, set run.workflow_id (PATCH) so API can signal; wait for signal in workflow; resume activity with decision.

**Checkpoint G:** Trigger an approval interrupt; call approve API; workflow resumes and completes.

---

## 9. Validation summary

- **A:** TaskBoard builds and tests pass; claim/release/attachments work.
- **B:** Worker runs; one stub task flows Ready→Done.
- **C:** Workspace has clone and branch.
- **D:** LangGraph produces checklist and task_result; interrupt/signal works.
- **E:** PR created; attachments on ticket.
- **F:** Polling detects merged; task closes and lock released.
- **G:** Human approval flow end-to-end.

---

## 10. Config / env (worker)

- `TASKBOARD_URL` — TaskBoard API base URL.
- `TASKBOARD_TOKEN` — Bearer token.
- `GITHUB_TOKEN` — For clone and PR/checks API.
- `REPO_CLONE_ROOT` — Directory for cloning repos (e.g. `/tmp/dark-factory-workspaces`).
- `TEMPORAL_HOST` — Temporal frontend (e.g. `localhost:7233`).
- `TEMPORAL_TASK_QUEUE` — e.g. `dark-factory`.
- `OPENAI_API_KEY` (or equivalent) for LangGraph LLM.

---

End of execution plan. Implement phases A→G in order; validate at each checkpoint.
