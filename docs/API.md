# TaskBoard API

Base URL: your API origin (e.g. `http://<host>:5173` when the API is served on port 5173).

All request/response bodies are JSON with **snake_case** keys.

---

## Authentication

Every request (except `GET /healthz`) must include:

```
Authorization: Bearer <token>
```

**Token (development):** `dev-token`  
(In production the API uses `TaskBoard:AuthToken` in appsettings or the `TASKBOARD_TOKEN` environment variable.)

**401** is returned if the header is missing or the token is invalid. Response body: `{ "error": "missing bearer token" }` or `{ "error": "invalid token" }`.

---

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/healthz` | No | Liveness check. Returns `{ "ok": true }`. |

---

## Tickets

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tickets` | Create ticket. Returns **201** and full ticket. |
| GET | `/tickets/{id}` | Get one ticket. **404** if not found or soft-deleted. |
| GET | `/tickets` | List tickets (paginated). Query: `status`, `repo`, `label`, `q`, `limit`, `offset`. |
| PATCH | `/tickets/{id}` | Partial update. Only send fields you change. |
| DELETE | `/tickets/{id}` | Soft-delete. **204** on success. |

**Ticket status values:** `Backlog`, `Ready`, `InProgress`, `Review`, `Done`, `Blocked`.

### POST /tickets (create)

**Body (all optional except `title`):**
```json
{
  "title": "Implement login",
  "status": "Ready",
  "priority": 1,
  "repo": "my-app",
  "labels": ["auth", "p0"],
  "acceptance_criteria": ["User can log in", "Session persists"],
  "test_plan": "E2E login flow",
  "description": "Optional description"
}
```

**Response (201):** Full ticket object including `id` (e.g. `T1`, `T2`), `created_at`, `updated_at`, `run` (null until a run exists).

### GET /tickets (list)

**Query parameters:**
- `status` — filter by status (e.g. `Ready`, `InProgress`)
- `repo` — filter by repo
- `label` — filter by label (exact match in labels array)
- `q` — search in title and description
- `limit` — page size (default 100, max 500)
- `offset` — skip (default 0)

**Response (200):**
```json
{
  "total": 42,
  "limit": 100,
  "offset": 0,
  "items": [ { "id": "T1", "title": "...", "status": "Ready", ... } ]
}
```

### PATCH /tickets/{id}

**Body:** Any subset of:
```json
{
  "title": "New title",
  "status": "InProgress",
  "priority": 2,
  "repo": "repo-name",
  "labels": ["a", "b"],
  "acceptance_criteria": ["item1"],
  "test_plan": "...",
  "description": "..."
}
```
Omit fields to leave unchanged. `title` cannot be set to empty.

---

## Dependencies (DAG)

A ticket’s **blocked_by** list is the set of ticket IDs that must be done before it can run. The graph must stay acyclic.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tickets/{id}/deps` | Get `blocked_by` and `blocks` for one ticket. |
| GET | `/deps?ids=T1,T2,T3` | Batch: get deps for many tickets. Response keys are ticket ids (lowercase in JSON). |
| PUT | `/tickets/{id}/deps` | **Replace** this ticket’s blockers. Body: `{ "blocked_by": ["T1", "T2"] }`. |

**Rules for PUT /tickets/{id}/deps:**
- No self-dependency.
- All IDs in `blocked_by` must exist and not be deleted.
- If the update would create a cycle, response is **409** with `{ "error": "dependency cycle detected", "cycle": ["T1","T2","T3","T1"] }`.

**Response for GET /tickets/{id}/deps (200):**
```json
{
  "blocked_by": ["T1", "T2"],
  "blocks": ["T4"]
}
```

**Response for GET /deps?ids=T1,T2 (200):**
```json
{
  "t1": { "blocked_by": [], "blocks": ["t2"] },
  "t2": { "blocked_by": ["t1"], "blocks": [] }
}
```

---

## Status transition

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tickets/{id}/transition` | Move ticket to another status. |

**Body:**
```json
{
  "to": "InProgress",
  "note": "Orchestrator started work",
  "by": "orch-1",
  "force": false
}
```

- `to` — required; one of the ticket status values.
- **Done → InProgress** is rejected unless `force: true`.
- Emits event `ticket.transition`.

---

## Runs and locking (for orchestrator)

The orchestrator should **acquire** a lock before working on a ticket, **heartbeat** to extend it, and **patch** the run for phase/CI state.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/runs/acquire` | Acquire or extend lock for a ticket. |
| POST | `/runs/heartbeat` | Extend lock (same owner, lock not expired). |
| PATCH | `/runs/{ticketId}` | Update run state (phase, attempt, branch, PR, CI, etc.). **Does not** change lock owner/expiry. |

### POST /runs/acquire

**Body:**
```json
{
  "ticket_id": "T5",
  "owner": "orch-1",
  "ttl_seconds": 1800
}
```

- `ttl_seconds` must be > 0.
- If no one holds the lock (or it’s expired), **acquired: true** and lock is set to this owner and TTL.
- If another owner holds the lock, **acquired: false** and current run is returned.
- Same owner can re-acquire (idempotent).

**Response (200):**
```json
{
  "acquired": true,
  "run": {
    "ticket_id": "T5",
    "phase": "plan",
    "attempt": 0,
    "lock_owner": "orch-1",
    "lock_expires_at": "2025-02-22T00:30:00Z",
    "branch": null,
    "pr_number": null,
    "last_ci_state": "unknown",
    "last_summary": null,
    "last_error": null,
    "updated_at": "..."
  }
}
```

### POST /runs/heartbeat

**Body:** Same as acquire: `ticket_id`, `owner`, `ttl_seconds` (must be > 0).

- Only succeeds if current lock owner matches and lock has not expired.
- **200** with `{ "ok": true, "run": { ... } }` on success.
- **409** with `{ "ok": false, "error": "lock not held by owner or expired" }` if not allowed.

### PATCH /runs/{ticketId}

**Body (all optional):**
```json
{
  "phase": "implement",
  "attempt": 1,
  "branch": "feature/T5-login",
  "pr_number": 42,
  "last_ci_state": "pending",
  "last_summary": "PR opened",
  "last_error": null
}
```

**Phase values:** `plan`, `implement`, `test`, `review`, `integrate`.  
**CI state values:** `unknown`, `pending`, `success`, `failure`.

Lock owner and expiry **cannot** be changed via PATCH (only via acquire/heartbeat).

---

## Scheduler helpers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/eligible?repo=` | List tickets that are Ready, all blockers Done, and not locked (or lock expired). Optional `repo` filter. |
| GET | `/pick-next?repo=` | Best ticket to work on next (by score). Optional `repo` filter. |
| GET | `/validate` | Check DAG has no cycles. |

### GET /eligible

**Response (200):** Array of:
```json
{
  "ticket_id": "T3",
  "title": "Add login",
  "priority": 1,
  "repo": "my-app",
  "blockers": 0,
  "status": "Ready"
}
```

### GET /pick-next

**Response (200)** when a ticket is chosen:
```json
{
  "ticket_id": "T3",
  "score": 25,
  "reasons": {
    "downstream_unblocked_count": 2,
    "critical_path_depth": 1,
    "priority": 1,
    "score": 25,
    "has_active_lock": false,
    "all_blockers_done": true
  },
  "reason": null
}
```

**When no ticket is eligible:**
```json
{
  "ticket_id": null,
  "score": null,
  "reasons": null,
  "reason": "none eligible"
}
```

**Scoring:** `score = 10 * downstream_unblocked_count + 5 * critical_path_depth + priority`. Higher is better.

### GET /validate

**Response (200):**
- No cycle: `{ "ok": true, "cycles": [] }`
- Cycle found: `{ "ok": false, "cycles": [["T1","T2","T3","T1"]] }`

---

## Ticket updates (activity)

Agents or users can post short updates to a ticket (e.g. “Started working”, “Doing QA”, “Completed”). These appear as a running log with time and author.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tickets/{id}/updates` | Post an update to the ticket. Creates an event `ticket.update`. |

### POST /tickets/{id}/updates

**Body:**
```json
{
  "message": "Started working on login flow",
  "author": "agent-1"
}
```
`author` is optional (defaults to `"user"`). `message` is required.

**Response (201):** Created event with `id`, `ticket_id`, `type` `"ticket.update"`, `payload`: `{ "message", "author", "at" }` (ISO), `created_at`.

List updates (and other events) with **GET /events?ticket_id={id}&limit=50**. Newest first.

---

## Events

| Method | Path | Description |
|--------|------|-------------|
| POST | `/events` | Create an event (audit log). |
| GET | `/events` | List events. Query: `ticket_id`, `type`, `since`, `limit` (1–500, default 100). |

### POST /events

**Body:**
```json
{
  "ticket_id": "T5",
  "type": "orchestrator.started",
  "payload": { "agent": "orchestrator", "branch": "feature/T5" }
}
```
`ticket_id` is optional (e.g. for global events). If present, ticket must exist.

**Response (201):** Created event with `id`, `ticket_id`, `type`, `payload`, `created_at`.

### GET /events

**Query:** `ticket_id`, `type`, `since` (ISO datetime), `limit`.  
**Response (200):** Array of events, newest first.

---

## Suggested orchestrator flow

1. **Poll or webhook:** Call `GET /pick-next?repo=<your_repo>` (and optionally `GET /eligible`) to decide what to work on.
2. **Lock:** `POST /runs/acquire` with `ticket_id`, `owner` (e.g. your session key), `ttl_seconds` (e.g. 1800). If `acquired: false`, skip and pick another or retry later.
3. **Transition:** `POST /tickets/{id}/transition` with `to: "InProgress"`, `by: "orchestrator"`.
4. **Work:** Do plan/implement/test/review. Use `PATCH /runs/{ticketId}` to update `phase`, `branch`, `pr_number`, `last_ci_state`, etc. Call `POST /runs/heartbeat` before TTL expires to keep the lock.
5. **Done:** `POST /tickets/{id}/transition` with `to: "Done"`. Optionally `PATCH /runs/{ticketId}` to set final phase/CI state. Lock will expire; no explicit release.
6. **Logging:** `POST /events` for custom events (e.g. `orchestrator.completed`, `ci.finished`).

---

## Error responses

- **400** — Validation (e.g. empty title, invalid status, `ttl_seconds <= 0`). Body: `{ "error": "..." }` or `{ "error": "...", "missing": ["T99"] }`.
- **401** — Missing or invalid bearer token.
- **404** — Ticket or run not found. Body: `{ "error": "ticket not found" }` or similar.
- **409** — Conflict (e.g. dependency cycle, lock not held). Body: `{ "error": "...", "cycle": [...] }` or `{ "ok": false, "error": "..." }`.

All dates/times in responses are UTC in ISO 8601 form.
