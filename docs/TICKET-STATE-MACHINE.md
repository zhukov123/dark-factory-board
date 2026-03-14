# Ticket lifecycle state machine

Summary of ticket **statuses**, **run phases**, and all transitions (including worker-driven and planned auto-retry-risky behavior).

---

## 1. Ticket statuses (board/API)

| Status       | Meaning |
|-------------|---------|
| **Backlog**  | Not yet scheduled for work. Not eligible for pick-next. |
| **Ready**    | Scheduled; eligible for pick-next if no active run lock and all dependency blockers are Done. |
| **InProgress** | Claimed by a worker (run has lock) or being worked on (execute, tests, or re-addressing PR review). |
| **Review**   | PR opened; worker is waiting for CI/review (or human) before merge. |
| **Done**     | Work completed and PR merged (or manually closed). |
| **Blocked**  | Paused: either “Awaiting approval” (risky), “Rejected by human”, or “PR rejected”. |

---

## 2. Run phase (stored on the run, not ticket status)

Each ticket can have a **run** with a **phase** reflecting where the worker is:

| Phase               | Meaning |
|---------------------|---------|
| Plan                | Claim just happened; run starts in Plan. |
| Implement           | LangGraph execute (planner → implementer). PR is created after tests; Reviewer runs on the PR in review_pr activity. |
| Test                | Running task tests. |
| Review              | PR open; waiting for CI/review. |
| Integrate           | (Reserved.) |
| **AwaitingApproval**| Reviewer said “risky”; workflow paused for human Approve/Reject. Ticket is **Blocked** with note “Awaiting approval”. |

---

## 3. Transitions (who moves the ticket)

### 3.1 User / UI

- **Backlog → Ready**  
  User moves ticket to Ready (e.g. “Backlog → Ready” or drag). Makes it eligible for pick-next (if deps satisfied and no lock).

- **Any → Any (manual)**  
  Transition API allows any valid status change from the UI/API, except:
  - **Done → InProgress** requires `force=true` (e.g. re-open for another run).

- **Release run**  
  UI or API: `POST /runs/release`. Clears run lock only; does **not** change ticket status. After release, a Ready ticket becomes eligible for pick again.

### 3.2 Worker: claim

- **Ready → InProgress**  
  When `claim_task` succeeds: run gets `lock_owner` and `lock_expires_at`, ticket status set to InProgress. Only Ready tickets can be claimed.

### 3.3 Worker: execute and approval

- **InProgress; run phase → AwaitingApproval, ticket → Blocked**  
  When **review_pr** (Reviewer LLM reviewing the PR) returns **“risky”** and workflow is **not** in “skip human approval” mode: worker sets run phase to AwaitingApproval, transitions ticket to **Blocked** with note “Awaiting approval”, returns `needs_approval` + `decision_id`. Workflow then waits for Approve/Reject.

- **Blocked (Awaiting approval) — human Reject**  
  Workflow receives Reject: worker calls `transition_ticket(Blocked)` (note “Rejected by human”) and `close_task(..., Blocked)`. Ticket stays **Blocked**; run is released.

- **Blocked (Awaiting approval) — human Approve**  
  Workflow receives Approve: worker merges the PR and closes task (Done). Ticket **Done**.

- **skip_human_approval (auto-retry risky)**  
  When “skip human approval” is on and **review_pr** returns **“risky”**: workflow treats it like **fail** — re-runs implementer with the review body as feedback, updates PR, calls review_pr again. No human wait.

### 3.4 Worker: after execute (tests and PR)

- **InProgress → Review**  
  When PR is created successfully: worker transitions ticket to **Review** with note “PR opened”. Run phase reflects PR/review.

- **InProgress (PR creation failed)**  
  Worker transitions to **InProgress** with note “PR creation failed”, then `close_task(..., InProgress)`. Run released; ticket stays InProgress (PR required for Done).

- **Review → InProgress (“Re-addressing review”)**  
  When **review_pr** returns **fail** (or **risky** with skip_human_approval): worker transitions to **InProgress** with note “Re-addressing review”, re-runs execute (implementer) with review body as feedback, runs tests, pushes (updates same PR), then calls **review_pr** again. Ticket cycles until review is pass or rounds exhausted.

- **Review → Blocked (“PR rejected”)**  
  When PR is closed or rejected externally: worker transitions to **Blocked** with note “PR rejected”, then `close_task(..., Blocked)`. Run released.

- **Review → Done**  
  When **review_pr** returns **pass**: worker merges the PR (inside review_pr), then calls `close_task(..., Done)`. Run released; ticket **Done**.

---

## 4. State diagram (ticket status + main run phase)

```
                    ┌─────────────┐
                    │   Backlog   │
                    └──────┬──────┘
                           │ user: move to Ready
                           ▼
                    ┌─────────────┐     claim_task
                    │    Ready    │◄───────────────────────────────────┐
                    └──────┬──────┘                                    │
                           │ worker claim                               │ release run
                           ▼                                            │ (no status change)
                    ┌─────────────┐                                     │
                    │ InProgress  │─────────────────────────────────────┘
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┬────────────────────┐
         │                 │                 │                    │
         │ risky           │ PR opened       │                    │ PR creation failed
         │ (no skip_human) │                 │                    │
         ▼                 ▼                 │                    │
  ┌─────────────┐   ┌─────────────┐          │                    │
  │   Blocked   │   │   Review    │          │                    │
  │ (Awaiting   │   └──────┬──────┘          │                    │
  │  approval)  │          │                 │                    │
  └──────┬──────┘          │                 │                    │
         │                 │ merged           │                    │
         │ Reject          ▼                 │                    │
         │           ┌─────────────┐          │                    │
         │           │    Done     │          │                    │
         │           └─────────────┘          │                    │
         │                 ▲                  │                    │
         │                 │                  ▼                    ▼
         └─────────────────┴────────  InProgress (released)  InProgress (released)
          (Rejected by human)                                    (PR creation failed)
                           │
                           │ rejected (PR closed / CI failed)
                           ▼
                    ┌─────────────┐
                    │   Blocked   │
                    │ (PR rejected)
                    └─────────────┘

         changes_requested (from Review)
                           │
                           ▼
                    InProgress (Re-addressing review) → execute again → Review
```

---

## 5. Run lock and eligibility

- **Eligible for pick-next**: ticket **status = Ready**, run has **no active lock** (or lock expired), and all dependency blockers are **Done**.
- **Active lock**: run has `lock_owner` set and `lock_expires_at` > now. While locked, the ticket is excluded from pick-next even if status is Ready.
- **Release run**: clears `lock_owner` and `lock_expires_at`; does not change ticket status. Use to make a stuck or Blocked ticket eligible again (or to unstick after approval timeout).

---

## 6. Planned change (auto-retry risky)

With **skip_human_approval** (planned):

- **“Risky”** no longer transitions to **Blocked** or waits for human.
- Graph routes back to **implementer** with **reviewer summary** (mandatory).
- Ticket stays **InProgress** for up to 2 review rounds; then either **pass** (→ tests, PR, Done/Review/Blocked as today) or **risky again** (run ends, close_task leaves ticket InProgress).
- Implementer prompt must always include reviewer summary when re-running after fail or risky.
