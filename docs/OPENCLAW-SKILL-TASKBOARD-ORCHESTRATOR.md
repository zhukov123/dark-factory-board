# OpenClaw Skill: TaskBoard Orchestrator

Use this skill when subagents must autonomously pick tickets, claim ownership, post progress, and move tickets through stages in TaskBoard.

## Intent

Drive ticket execution safely in a multi-agent environment by using lock-first coordination and explicit stage transitions.

## API Access

- Base URL: `http://localhost:5173`
- Required header (all routes except health):
  - `Authorization: Bearer dev-token`
- Content type:
  - `Content-Type: application/json`
- Health probe:
  - `GET /healthz` -> `{ "ok": true }`

## Enums

- Ticket stages (`status`):
  - `Backlog`, `Ready`, `InProgress`, `Review`, `Done`, `Blocked`
- Run phases (`run.phase`):
  - `plan`, `implement`, `test`, `review`, `integrate`
- CI states (`run.last_ci_state`):
  - `unknown`, `pending`, `success`, `failure`

## Required Agent Identity

Every subagent must have a stable owner string for lock operations.

- `owner` format:
  - `<orchestrator-id>:<subagent-id>`
- Example:
  - `orch-main:agent-backend-2`

Never share the same owner string across concurrent workers.

## Primary Routes

### Discovery and Scheduling

- `GET /eligible?repo=<repo>`
  - Returns tickets currently executable (`Ready`, blockers done, lock free/expired)
- `GET /pick-next?repo=<repo>`
  - Returns best next ticket and scoring reasons
  - If none available: `{ "ticket_id": null, "reason": "none eligible" }`

### Ticket lifecycle

- `POST /tickets/{id}/transition`
  - Body:
    - `{ "to": "InProgress|Review|Done|Blocked|...", "note": "...", "by": "...", "force": false }`
  - Rule: `Done -> InProgress` requires `force: true`
- `POST /tickets/{id}/updates`
  - Body:
    - `{ "message": "human-readable progress", "author": "agent-x" }`
  - Creates event type `ticket.update`

### Locking and run metadata

- `POST /runs/acquire`
  - Body:
    - `{ "ticket_id": "T5", "owner": "orch:agent", "ttl_seconds": 1800 }`
  - Success shape:
    - `{ "acquired": true, "run": { ... } }`
  - Lock held by someone else:
    - `{ "acquired": false, "run": { ... } }`
- `POST /runs/heartbeat`
  - Body:
    - `{ "ticket_id": "T5", "owner": "orch:agent", "ttl_seconds": 1800 }`
  - Success:
    - `{ "ok": true, "run": { ... } }`
  - Failure:
    - `409 { "ok": false, "error": "lock not held by owner or expired" }`
- `PATCH /runs/{ticketId}`
  - Body supports:
    - `phase`, `attempt`, `branch`, `pr_number`, `last_ci_state`, `last_summary`, `last_error`

### Dependencies and validation

- `GET /tickets/{id}/deps`
- `GET /deps?ids=T1,T2,T3`
- `PUT /tickets/{id}/deps` with `{ "blocked_by": ["T1", "T2"] }`
  - Rejects self-dependency, missing ids, and cycles (`409`)
- `GET /validate`
  - DAG integrity check

### Event feed

- `GET /events?ticket_id=T5&limit=50`
- `POST /events`
  - Custom audit records (`orchestrator.started`, `ci.finished`, etc.)

## Standard Execution Protocol

Follow this exact sequence for each work attempt.

1. **Choose work**
   - Call `GET /pick-next?repo=<repo>`.
   - If `ticket_id == null`, sleep with backoff and retry.

2. **Acquire lock**
   - Call `POST /runs/acquire`.
   - If `acquired == false`, do not touch that ticket; go back to step 1.

3. **Mark start**
   - Transition ticket to `InProgress`.
   - Post update message: start intent + scope.
   - Patch run phase to `plan`.

4. **Work loop**
   - Keep heartbeat alive at interval `ttl_seconds * 0.4` (for 1800s TTL, heartbeat every ~12m).
   - Update run phase as work advances:
     - `plan` -> `implement` -> `test` -> `review` -> `integrate`
   - Post milestone updates for meaningful state changes.

5. **Complete**
   - If successful:
     - Transition to `Review` or `Done` (team policy dependent).
     - Patch final run metadata (`last_ci_state`, summary).
     - Post completion update.

6. **Block or fail**
   - Patch run with `last_error`.
   - Transition to `Blocked` if waiting on external dependency/action.
   - Post unblock criteria via ticket update.

## Stage Movement Policy

Use this policy to keep behavior deterministic across subagents.

- Move to `InProgress` only after lock acquisition succeeds.
- Use `Review` when code is ready but waiting for review/merge validation.
- Use `Done` only when acceptance criteria are satisfied.
- Use `Blocked` when progress is impossible without external input.
- Keep `Ready` tickets untouched unless taking ownership or editing metadata.

## Error Handling and Retries

- `400` validation error:
  - Do not retry unchanged request.
  - Correct payload first.
- `401` auth error:
  - Refresh token/config and retry once.
- `404` not found:
  - Treat as terminal for that ticket id.
- `409` conflict:
  - For lock conflict (`acquired: false` or heartbeat 409): choose another ticket.
  - For dependency cycle: do not retry same `blocked_by`; escalate to planner.
- `5xx` transient:
  - Retry up to 3 times with exponential backoff: `2s`, `4s`, `8s`.

## Concurrency Rules

- Never run work on a ticket without a successful lock acquire.
- Never assume lock ownership after heartbeat failure.
- If heartbeat fails with `409`, immediately stop work updates for that ticket and reacquire or requeue.
- Treat `PATCH /runs/{ticketId}` as metadata only; lock ownership is controlled by acquire/heartbeat.

## Recommended Update Message Templates

- Start:
  - `Started: planning implementation for <scope>`
- Milestone:
  - `Progress: implemented <component>, now running tests`
- Review handoff:
  - `Ready for review: PR #<n>, CI <state>`
- Blocked:
  - `Blocked: waiting on <dependency>. Unblock by <action>`
- Done:
  - `Done: completed acceptance criteria <short list>`

## Minimal Request Examples

```json
{
  "ticket_id": "T42",
  "owner": "orch-main:agent-api-1",
  "ttl_seconds": 1800
}
```

```json
{
  "to": "InProgress",
  "note": "Acquired by orchestrator, starting work",
  "by": "orch-main",
  "force": false
}
```

```json
{
  "phase": "implement",
  "attempt": 1,
  "branch": "feature/T42-auth",
  "pr_number": 128,
  "last_ci_state": "pending",
  "last_summary": "PR opened, CI running",
  "last_error": null
}
```

```json
{
  "message": "Progress: API endpoints implemented, validating tests",
  "author": "agent-api-1"
}
```

## Optional Enhancements

- Add webhook trigger to reduce polling frequency.
- Add explicit lock owner checks for run patch route.
- Add stricter transition matrix if you want enforced workflow gates.
