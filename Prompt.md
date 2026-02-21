# Prompt for Codex: Build v1 Task Board (API + UI) for OpenClaw Orchestration

## 0) What we are building and why (context)

We want a custom Kanban task board that models a simple dependency DAG, so an OpenClaw-based orchestrator can continuously work through dozens of stories.

OpenClaw will be triggered by the board via webhook (later). OpenClaw supports:

* Webhooks endpoints `/hooks/wake` (200) and `/hooks/agent` (202 async) and auth/rate-limits: <https://docs.openclaw.ai/automation/webhook>
* A lane-aware command queue that serializes per session key `session:<key>` and caps parallelism: <https://docs.openclaw.ai/concepts/queue>
* Cron jobs as a fallback heartbeat: <https://docs.openclaw.ai/automation/cron-jobs>
* Subagents for specialist roles (planner/tester/reviewer) inside one ticket: <https://docs.openclaw.ai/tools/subagents>

This board is the “source of truth” for tickets + dependencies + status. Source control/PRs live in GitHub (integration later).

## 1) Deliverables (v1)

Build:


1. `TaskBoard.Api` — .NET 8 Minimal API with SQLite persistence
2. `TaskBoard.Ui` — React UI (TypeScript) that talks to the API
3. `TaskBoard.Tests` — basic integration tests for API and key DAG logic
4. `README.md` — how to run API+UI in dev, and how to run in prod

### UX goals (v1)

* See tickets in Kanban columns
* Create/edit tickets
* Drag/drop tickets between columns
* Edit dependencies (“Blocked by” list) and visualize blockers
* See which tickets are eligible (Ready + blockers done + not locked)
* See what `/pick-next` would return (and why)
* See per-ticket run state (phase, attempt, lock owner/expires, branch, PR number, CI state)
* See event log per ticket (transitions, run updates)

## 2) Tech choices

* API: C# .NET 8 Minimal API
* DB: SQLite (file)
* Data: EF Core (prefer) or Dapper (ok). Choose simplest stable.
* UI: React + TypeScript + Vite (dev), build to static assets served by API in prod
* Styling: simple (Tailwind optional). Keep dependencies light.
* Auth: simple bearer token header for API calls.

## 3) Data model

### Ticket Status enum

Backlog | Ready | InProgress | Review | Done | Blocked

### Tables

tickets(id, title, status, priority, repo, labels_json, acceptance_criteria_json, test_plan, description, created_at, updated_at)
deps(ticket_id, blocked_by_id)
runs(ticket_id, phase, attempt, lock_owner, lock_expires_at, branch, pr_number, last_ci_state, last_summary, last_error, updated_at)
events(id, ticket_id, type, payload_json, created_at)

### Phase enum

plan | implement | test | review | integrate

### CI state enum

unknown | pending | success | failure

### SQLite schema (create migrations)

\[Same as previous spec; implement migrations in EF or raw SQL, but must enforce FKs\]

## 4) API contract (REST)

### Auth

Authorization: Bearer <TASKBOARD_TOKEN> (from env or appsettings)
Return 401 if missing/invalid.

### Health

GET /healthz -> {"ok":true}

### Tickets

POST /tickets
GET /tickets/{id}
GET /tickets?status=&repo=&label=&q=
PATCH /tickets/{id}
DELETE /tickets/{id} (optional; OK to omit in v1)

### Dependencies

PUT /tickets/{id}/deps  body: { "blocked_by": \["T1","T2"\] }  (replace set)
GET /tickets/{id}/deps  -> { "blocked_by":\[...\], "blocks":\[...\] }

Rules:

* no self-dep
* validate target tickets exist
* must remain acyclic: reject with 409 and show one cycle path if update would introduce a cycle

### Transition (status changes)

POST /tickets/{id}/transition body: { "to":"InProgress", "note":"...", "by":"user|orch" }

* Validate transitions (simple: allow any except Done->InProgress unless force=true)
* Always write an events row: type="ticket.transition"

### Runs / locking (critical)

POST /runs/acquire body: { "ticket_id":"T123", "owner":"orch-1", "ttl_seconds":1800 }

* create run row if missing with phase=plan
* acquire if no lock or expired
* return { acquired: bool, run: RunDto }

POST /runs/heartbeat body: { "ticket_id":"T123", "owner":"orch-1", "ttl_seconds":1800 }

* only if owner matches and not expired; extends lock

PATCH /runs/{ticket_id}

* update phase/attempt/branch/pr_number/last_ci_state/last_summary/last_error
* write event type="run.update"

### Scheduler helpers

GET /eligible?repo=

* tickets where:
  * status=Ready
  * all blockers are Done
  * no active lock (or lock expired)

GET /pick-next?repo=

* returns { ticket_id:"T123", score:123, reasons:{...} } or { ticket_id:null, reason:"none eligible" }
* scoring:
  score = 10*downstream_unblocked_count + 5*critical_path_depth + priority
* include reasons in response so UI can display why it picked it.

GET /validate

* returns { ok:true } or { ok:false, cycles:\[\["T1","T2","T3","T1"\]\] }

### Events

POST /events body: { ticket_id?: "T123", type:"info|error|...", payload:{...} }
GET /events?ticket_id=&type=&since=&limit=

## 5) DAG algorithms (must implement)

* Cycle detection (DFS color marking)
* Eligibility
* Critical path depth (longest path in reverse edges)
* Downstream unblocked simulation count
* “Would-introduce-cycle” check for deps update

## 6) UI requirements (React)

### Pages / Views


1. Kanban Board

* Columns for each status
* Cards show: id, title, repo, labels, priority, blockers count, run lock indicator
* Drag/drop between columns -> calls transition endpoint
* Quick filter by repo and label and search query


2. Ticket Detail Drawer/Modal

* Edit title/desc/criteria/test_plan/labels/priority/repo
* Show dependencies:
  * “Blocked by” list (editable via multi-select)
  * “Blocks” list (read-only)
  * Visual indicators of blocked/done status
* Run state panel:
  * phase, attempt, lock_owner, lock_expires_at, branch, pr_number, last_ci_state
  * last_summary, last_error
* Events panel:
  * timeline list


3. Dependency Graph View (simple)

* Show nodes and edges for current repo/filter
* It can be very basic (even a list-based graph / adjacency), but better if you can render using a lightweight graph lib.
* Must highlight cycles when /validate says ok=false.


4. Orchestrator View

* Panel showing:
  * /eligible list
  * /pick-next result + reasons + score breakdown
  * a “Simulate Done” tool (optional): pick a ticket and show which tickets would become eligible

### UI architecture

* Use a typed API client module
* Keep state with React Query or simple hooks
* Poll /eligible and /pick-next every 5–10 seconds (or on demand button)

### UI auth

* Simple token input stored in localStorage
* Add token to Authorization header
* If 401, prompt user to set token.

## 7) Run & build

* Dev:
  * run API on <http://localhost:5005>
  * run UI with Vite on <http://localhost:5173> and proxy to API
* Prod:
  * build UI -> copy dist/ to API wwwroot
  * API serves UI and API under same origin

## 8) Tests

* API integration tests:
  * create tickets + deps
  * deps update rejects cycles
  * eligibility works (blocked ticket not eligible until blocker Done)
  * lock acquire race (two owners; only one succeeds; expiry works)
  * pick-next returns expected ticket on a small DAG

## 9) Acceptance criteria for v1

* dotnet test passes
* API creates DB automatically if missing
* Swagger enabled in dev
* UI supports: board drag/drop, ticket edit, deps edit, eligible + pick-next view, events view
* /validate detects cycles; /pick-next respects eligibility + locks and returns score reasons


