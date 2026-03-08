# Dark Factory flow analysis (React task manager run)

## Outcome summary

| Ticket | Title | Status | Run phase | Branch | PR |
|--------|--------|--------|-----------|--------|-----|
| T75 | Set up React app and project structure | **Done** | plan | task/T75-T75 | None |
| T76 | Add task list view | **Done** | plan | task/T76-T76 | None |
| T77 | Add form to create new tasks | **Done** | plan | task/T77-T77 | None |
| T78 | Mark complete and delete tasks | **Done** | plan | task/T78-T78 | None |
| T79 | Add filtering (all/active/completed) | **Done** | plan | task/T79-T79 | None |

All five tickets were processed **in order** (T75 → T76 → … → T79). Each reached **Done**; none have a PR or real code changes.

---

## What the workflow did (per ticket)

1. **Pick next** – Chose the next Ready ticket with no unmet dependencies (T75 first, then T76 after T75 was Done, etc.).
2. **Claim** – Claimed the ticket (InProgress, lock).
3. **Prepare workspace** – Created a workspace directory per ticket (e.g. `/tmp/dark-factory-workspaces/ticket_T75`), created branch `task/T75-T75`. No `WORKSPACE_PATH` or `WORKSPACE_REPO` was set; repo from workflow input was `task-manager-react`. With no `GITHUB_TOKEN` (or invalid slug), the worker did **not** clone a repo; it created an **empty** directory and wrote `.dark-factory.json` only.
4. **Execute (LangGraph)** – Ran the graph. With **no `OPENROUTER_API_KEY` and no `LMSTUDIO_BASE_URL`**, the runner does a **no-op**: it writes a minimal `task_result.json` (`pass: true`, `files_changed: []`, no LLM calls) and returns success. So **no code was generated** for any ticket.
5. **Run tests** – Ran in the workspace; **pytest** was found and ran. In an empty workspace there are **0 tests**, so “no tests ran” and exit code 0 → treated as **success**. Logs were uploaded as `run_tests.log`.
6. **Open/update PR** – `open_or_update_pr` needs a valid GitHub repo slug (`owner/repo`) and `GITHUB_TOKEN`. Repo was `task-manager-react` (no owner), and/or token was missing, so **no PR was created**; `pr_number` stayed 0.
7. **Wait for review/CI** – When `pr_number <= 0`, the activity **immediately returns `"merged"`** (so the workflow doesn’t block).
8. **Close task** – Released the lock and transitioned the ticket to **Done**.

So: **flow ran end-to-end**, but with **no clone**, **no LLM**, and **no PRs**.

---

## Why run phase stayed "plan"

The API creates a run with `Phase = RunPhase.Plan`. The worker only updates run phase to **AwaitingApproval** when LangGraph hits a human-in-the-loop interrupt. It does **not** patch phase to Implement / Test / Review in the normal path, so the UI still shows **plan** even after execute and tests.

---

## What you’d need for real runs

| Goal | What to set |
|------|-------------|
| **Real repo clone** | `GITHUB_TOKEN` and `WORKSPACE_REPO=owner/task-manager-react` (or pass `repo: "owner/task-manager-react"` in workflow input). |
| **Real code generation** | `OPENROUTER_API_KEY` or `LMSTUDIO_BASE_URL` (and optionally `LMSTUDIO_MODEL`) so LangGraph calls the LLM. |
| **Real PRs** | Same as clone: valid `owner/repo` and `GITHUB_TOKEN` so the worker can push and create PRs. |
| **Single local workspace** | `WORKSPACE_PATH=/path/to/your/git/repo` so the worker uses that directory (and its GitHub remote) instead of creating empty dirs. |

---

## Attachments (example: T75)

- **task_result.json** – `{ "pass": true, "files_changed": [], "tests_run": [], "assumptions": [] }` (no-op LLM).
- **run_tests.log** – Pytest ran in the workspace; “collected 0 items”, “no tests ran”.

So the flow and dependencies behaved as designed; the missing configuration (LLM, GitHub repo/token, optional workspace path) is why there are no code changes and no PRs.
