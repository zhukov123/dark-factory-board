# Review: Temporal + LangGraph Dark Factory Plan

This document reviews the **Temporal + LangGraph Orchestration** plan against the existing dark-factory-board codebase (TaskBoard API + UI) and provides concrete gaps, alignment notes, and implementation recommendations.

**For implementation:** Use **[DARK-FACTORY-EXECUTION-PLAN.md](./DARK-FACTORY-EXECUTION-PLAN.md)** as the single one-shot spec for an LLM programming agent: linear phases, pinned tech stack, exact API contracts, activity I/O, and validation checkpoints.

---

## What exists today vs what’s left

**Done (foundation):**

- **TaskBoard** — Kanban API + UI: tickets, statuses, dependencies, run lock (acquire/heartbeat), eligible/pick-next, transitions, events. This is the “first step”: the task board that the orchestrator will drive.

**Not built yet (full dark factory):**

Everything below is still to implement. The checklist and order in this doc are the roadmap.

| # | Component | Description |
|---|-----------|-------------|
| 1 | **Temporal Server + DB** | Self-hosted Temporal + persistence (e.g. Postgres). |
| 2 | **Worker service** | Process that runs the workflow + activities; hosts TaskBoard client, Git, and LangGraph. |
| 3 | **Task board client** | Thin client over TaskBoard API (list, acquire, heartbeat, transition, patch run, updates, events). |
| 4 | **DarkFactoryRun workflow** | Temporal workflow: loop PickNextTask → … → CloseTask; when no eligible task, sleep (e.g. 5 min) and retry until task found or max idle reached, then exit. |
| 5 | **Activities (in order)** | PickNextTask, ClaimTask, PrepareWorkspace, ExecuteTaskWithLangGraph, RunTaskTests, OpenOrUpdatePR, WaitForReviewAndCI, CloseTask. |
| 6 | **Task spec format** | Build task spec as Markdown from ticket fields only (title, description, acceptance_criteria, test_plan, repo, labels); no spec_ref. |
| 7 | **LangGraph graph** | Planner → Implementer → Reviewer, with human-approval interrupt; runs inside ExecuteTaskWithLangGraph. |
| 8 | **Git + CI integration** | Clone, branch, push, create/update PR; **worker polls** Git/CI API for status; update run via PATCH; no TaskBoard callback. |
| 9 | **Artifact storage** | Store artifact files in TaskBoard store; attach to ticket via ticket-attachments API (e.g. POST/GET /tickets/{id}/attachments). |
| 10 | **Human approval** | In scope: interrupt, Blocked + phase `awaiting_approval`; run field `pending_approval_decision_id`; API `POST /runs/{ticketId}/approve` and `/reject` (signal workflow). |
| 11 | **API changes** | Add `POST /runs/claim`, `POST /runs/release` (or `/runs/{ticketId}/release`), ticket attachments, approve/reject, run phase `awaiting_approval`, run field `pending_approval_decision_id`. |

---

## Executive summary

The plan is **well-structured and feasible**. Temporal as durable conductor and LangGraph as the agent runtime is a sound split. Your existing TaskBoard API already covers most of the “task board contract” (eligible, pick-next, acquire/heartbeat, transitions, run metadata). The main work is implementing the Worker + workflow/activities, defining the task-spec format, and wiring LangGraph + Git/CI. A few API and product gaps should be closed for a “real” dark factory.

---

## What already fits

### 1. Task board contract

Your API already supports the minimum contract described in the plan:

| Plan requirement | TaskBoard today |
|-----------------|-----------------|
| List tasks by status + filters | `GET /tickets?status=Ready&repo=...` |
| Atomic claim/lock | **To add:** `POST /runs/claim` (owner + TTL); atomically acquire + transition Ready→InProgress. Existing: `POST /runs/acquire`, heartbeat. |
| Lease + heartbeat | `POST /runs/heartbeat` with same owner + `ttl_seconds` |
| Update fields (branch, PR, CI, artifacts) | `PATCH /runs/{ticketId}`: `branch`, `pr_number`, `last_ci_state`, `last_summary`, `last_error` |
| Append comments/events | `POST /tickets/{id}/updates`, `POST /events` |
| State transitions | `POST /tickets/{id}/transition` with `to` |
| Dependencies | `blocked_by` + `/eligible` only returns when blockers are Done |

So **PickNextTask** → `GET /pick-next?repo=...`, **ClaimTask** → `POST /runs/claim` (single atomic call).

### 2. Status alignment

Plan wording vs API:

- Plan: “In Progress” → API: **`InProgress`** (one token).
- Plan: “In Review” → API: **`Review`** (not “In Review”).

Recommendation: Use the API enum values (`Backlog`, `Ready`, `InProgress`, `Review`, `Done`, `Blocked`) consistently in the orchestrator and docs to avoid bugs.

### 3. Orchestrator protocol

Your [OPENCLAW-SKILL-TASKBOARD-ORCHESTRATOR.md](./OPENCLAW-SKILL-TASKBOARD-ORCHESTRATOR.md) already defines the intended sequence (pick-next → acquire → transition → work → heartbeat → transition to Review/Done/Blocked). The Temporal plan is a formalization of that with durable workflows and LangGraph inside activities.

---

## Gaps and recommendations

### 1. Task spec (Markdown)

**Decision: generated from ticket only (no spec_ref).**

The task spec is a **generated Markdown string** per ticket. The worker builds it from: `title`, `description`, “Acceptance criteria” (from the array), “Test plan”, and optionally `repo`/`labels`. That string is passed to LangGraph. No API change. Document the spec schema (Purpose, Scope, Must-have, Must-not, Tests, Completion) so ticket content can be structured to match it when authors create tickets.

### 2. Atomic “Ready → In Progress” (claim)

**Decision: add `POST /runs/claim`.**

Add a single endpoint `POST /runs/claim` with body `{ "ticket_id", "owner", "ttl_seconds" }` that in one transaction: (1) checks ticket status is Ready, (2) creates/updates run with lock (same semantics as acquire), (3) transitions ticket to InProgress. Returns success + run, or failure if not Ready or lock held by another. **ClaimTask** activity calls this once; no two-step acquire-then-transition.

### 3. Human approval (signals)

**Decision: human approval flow is in scope.**

- Use **Blocked** for “waiting on human approval.” Distinguish “blocked on approval” vs “blocked on dependency” by setting run **phase** to **`awaiting_approval`** when blocking for approval (add this phase value to the run model; UI/worker treat Blocked + `phase === awaiting_approval` as waiting on human).
- When LangGraph interrupts: (1) transition ticket to Blocked, (2) set run phase to `awaiting_approval`, (3) post event/update with decision memo and `decision_id`, (4) return a result so the workflow **waits for a Temporal signal** (`Approve(decision_id)` / `Reject(decision_id)`). On signal, workflow continues and resumes LangGraph from checkpoint.
- Add run field **`pending_approval_decision_id`** so the UI can show “Waiting for approval: &lt;id&gt;” and send it when calling the approve/reject API. Add API: e.g. **`POST /runs/{ticketId}/approve`** and **`POST /runs/{ticketId}/reject`** with body `{ "decision_id", "note" }`; API records the decision and signals the Temporal workflow.

### 4. Artifact storage and links

**Decision: store artifact files in the TaskBoard store and attach them to the ticket.**

- Artifacts (logs, `task_result.json`, etc.) are **stored in the TaskBoard store** (API-managed storage) and **attached to the ticket**. The worker uploads artifacts via the TaskBoard API; no separate object store or worker-local-only storage.
- Add **ticket attachments** (or ticket-scoped artifact store): e.g. **`POST /tickets/{id}/attachments`** (upload file, optional `name`/`type`, e.g. `task_result.json`, `run.log`); **`GET /tickets/{id}/attachments`** (list); **`GET /tickets/{id}/attachments/{attachmentId}`** or similar to download. Attachments are keyed by ticket (and optionally run/timestamp if needed). Run fields `branch`, `pr_number`, `last_ci_state`, `last_summary`, `last_error` remain for PR/CI and summary text; artifact *files* live as ticket attachments in the TaskBoard store.
- Use **POST /tickets/{id}/updates** and **POST /events** for human-readable summaries and audit (e.g. “PR opened: …”, “CI passed: …”).

### 5. Phase ordering and run phases

The plan says “Enforcing phase ordering and dependency constraints.” Your run already has **phases**: `plan`, `implement`, `test`, `review`, `integrate`. The workflow steps (PrepareWorkspace → ExecuteTaskWithLangGraph → RunTaskTests → OpenOrUpdatePR → WaitForReviewAndCI → CloseTask) map cleanly to these.

**Recommendation:** Have each activity **patch the run phase** when it starts (e.g. after PrepareWorkspace set `phase: "implement"`, after OpenOrUpdatePR set `phase: "review"`). That gives you a clear audit trail and aligns with the existing orchestrator skill.

### 6. “Close task” and releasing the lock

**Decision: add explicit release.**

Add **`POST /runs/release`** (or **`POST /runs/{ticketId}/release`**) with body identifying the owner (e.g. `{ "ticket_id", "owner" }` or rely on auth): if the caller is the current lock owner, clear `lock_owner` and `lock_expires_at` for that ticket. **CloseTask** calls this (before or after transitioning to Done) so the lock is released immediately and another run can claim the ticket without waiting for TTL.

---

## Implementation checklist (refined)

Using your plan’s checklist, with notes from this review:

- [ ] **Temporal workflow:** `DarkFactoryRun`  
  - Loop: PickNextTask → ClaimTask → … → CloseTask. When PickNextTask returns no eligible task: **sleep** for a configured duration (e.g. 5 min), then call PickNextTask again; repeat until a task is found or a max idle/time limit is reached, then exit.
- [ ] **Activities:**
  - [ ] **PickNextTask** — `GET /pick-next?repo=...`; return `(ticket_id, task_spec)` where task_spec is the Markdown string built from ticket fields (title, description, acceptance_criteria, test_plan, repo, labels).
  - [ ] **ClaimTask** — `POST /runs/claim` with `ticket_id`, `owner`, `ttl_seconds`; on failure (not Ready or lock held), return to PickNextTask.
  - [ ] **PrepareWorkspace** — clone, branch `task/<phase>-<task_slug>`, write run metadata; `PATCH /runs/{ticketId}` (e.g. branch), post update/event.
  - [ ] **ExecuteTaskWithLangGraph** — run LangGraph (planner → implementer → reviewer, with human-approval interrupt); post checklist/updates; on interrupt, transition to Blocked and return “needs_approval” so workflow waits for signal, then resumes.
  - [ ] **RunTaskTests** — run task-level tests; capture logs; post results; on failure, return failure so workflow can re-invoke LangGraph or retry.
  - [ ] **OpenOrUpdatePR** — push, create/update PR; `PATCH /runs/{ticketId}` (pr_number, etc.); upload artifacts to ticket via TaskBoard attachments API; transition to `Review`.
  - [ ] **WaitForReviewAndCI** — **worker polls** Git host/CI API (e.g. GitHub PR + checks) for PR and CI status; update run via `PATCH /runs/{ticketId}` (`last_ci_state`, etc.); on merged → CloseTask; on “changes requested” → transition back to InProgress and re-run ExecuteTaskWithLangGraph (pass reviewer feedback); on rejected → Blocked. No TaskBoard CI callback endpoint; worker needs Git/CI credentials.
  - [ ] **CloseTask** — call **`POST /runs/release`** (or `/runs/{ticketId}/release`) to release the lock, transition to `Done`, post final comment; stop heartbeating.
- [ ] **Task board client** — thin client over existing API: list, acquire, heartbeat, transition, patch run, updates, events. Already specified in API.md and orchestrator skill.
- [ ] **Git + CI integration** — PR creation and status: worker polls Git/CI API; update run via PATCH; no TaskBoard callback.
- [ ] **Artifact storage** — TaskBoard store: add ticket-attachments API (e.g. `POST /tickets/{id}/attachments`, `GET /tickets/{id}/attachments`); worker uploads logs and `task_result.json` as ticket attachments.
- [ ] **Approval mechanism** — Run field `pending_approval_decision_id`; API `POST /runs/{ticketId}/approve` and `POST /runs/{ticketId}/reject` with `{ "decision_id", "note" }`; API signals Temporal workflow.

---

## Suggested implementation order

1. **Task board client + Temporal worker skeleton**  
   Implement PickNextTask, ClaimTask, CloseTask (and a minimal PrepareWorkspace that only patches run) so a workflow can “pick one task, claim it, then close it” without LangGraph. Validates acquire/transition/heartbeat and status mapping.

2. **PrepareWorkspace (real)**  
   Clone repo, create branch, write metadata; integrate with your repo layout and branch naming.

3. **LangGraph graph (single activity)**  
   Implement ExecuteTaskWithLangGraph with a minimal graph (e.g. planner only, or planner + implementer stub) that reads task spec from ticket and posts a checklist. No Git writes yet.

4. **RunTaskTests + OpenOrUpdatePR**  
   Run tests from workspace; push branch and open PR; patch run with PR/CI links.

5. **WaitForReviewAndCI**  
   Worker polls Git/CI API and implement “merged / changes requested / rejected” branching; on "changes requested" re-enter ExecuteTaskWithLangGraph (pass reviewer feedback); no separate fix-up activity.

6. **Human approval**  
   Add interrupt in LangGraph, Blocked + phase `awaiting_approval`, run field `pending_approval_decision_id`; implement `POST /runs/{ticketId}/approve` and `/reject` that signal the workflow; UI can show “Waiting for approval” and call the API.

7. **Artifacts and observability**  
   Add ticket-attachments API; worker persists task_result.json and logs as ticket attachments in TaskBoard store.

---

## Definition of success (unchanged)

The plan’s definition of success remains valid:

- Tasks move Ready → Done with minimal manual steps.
- Failures are visible and recoverable (Temporal history + run/ticket state).
- Risky decisions can pause for approval and resume.
- Each task yields a PR (or commit), a task result summary, and a reproducible trail (seed, base commit, logs).

---

## Summary table

| Area | Status | Action |
|------|--------|--------|
| Task board contract | Met + claim + release | Add `POST /runs/claim` and `POST /runs/release` (or `/runs/{ticketId}/release`). |
| Status/phase enums | Align | Use API values (`InProgress`, `Review`); document in orchestrator. |
| Task spec | Decided | Build from ticket fields only; document spec schema for ticket authors. |
| Human approval | Decided | Blocked + phase `awaiting_approval`; run field `pending_approval_decision_id`; API approve/reject signals workflow. |
| Artifacts | Decided | Store in TaskBoard; attach to ticket via /tickets/{id}/attachments (upload, list, download). |
| Lock release | Decided | Add `POST /runs/release` (or `/runs/{ticketId}/release`); CloseTask calls it. |

Overall, the plan is **ready to implement** with the above refinements. CI: worker polls Git/CI API; no callback. Remaining design detail: LangGraph graph (tool set, checkpointing, interrupt semantics) can be iterated once the first three implementation steps are in place.

---

## Summary: what’s left to complete the dark factory

- **You have:** TaskBoard (API + UI) as the source of truth for tasks and run state.
- **You still need:**
  1. **Temporal** (server + DB) and a **Worker** that runs the `DarkFactoryRun` workflow and all activities.
  2. A **TaskBoard client** used by the worker (can be a small library or inline HTTP calls).
  3. **All 8 activities** implemented and wired (PickNextTask → ClaimTask → PrepareWorkspace → ExecuteTaskWithLangGraph → RunTaskTests → OpenOrUpdatePR → WaitForReviewAndCI → CloseTask).
  4. **LangGraph** inside `ExecuteTaskWithLangGraph`: planner → implementer → reviewer, with task spec built from ticket fields (and optional interrupt for approval).
  5. **Git/CI**: clone, branch, push, PR creation/update; worker polls Git/CI API for status and updates run via PATCH.
  6. **Artifacts**: store in TaskBoard; ticket-attachments API (POST/GET /tickets/{id}/attachments); worker uploads logs and task_result.json as attachments.
  7. **Human approval** (interrupt, phase `awaiting_approval`, `pending_approval_decision_id`, approve/reject API). **Decided:** atomic claim `POST /runs/claim`; explicit release `POST /runs/release`; artifacts in TaskBoard store attached to ticket.

Use the **Suggested implementation order** (steps 1–7) and the **Implementation checklist** above as the concrete sequence for building what’s left.
