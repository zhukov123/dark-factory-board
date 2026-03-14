# T1 PR failure analysis

## Summary

T1 (Project Scaffolding & Dev Environment Setup) had **5 consecutive PR review failures** before the workflow hit the max review rounds and transitioned the ticket back to InProgress. Each cycle: Implementer pushed new commits → Reviewer ran on the PR → Verdict **fail** → Implementer ran again (with feedback).

## What happened (from event history)

| Round | Commit range      | Reviewer verdict |
|-------|-------------------|------------------|
| 1     | initial → c75b775 | **fail**: Missing Vitest/Playwright, test scripts, directory structure (only `src/index.css`) |
| 2     | c75b775..4582219  | **fail**: Vitest/Playwright added; directory structure still incomplete (only `src/test` visible) |
| 3     | 4582219..2fe30f1  | **fail**: Structure and scripts present; `.env.example` missing from diff; PR description says 5 files but diff has more (inconsistent) |
| 4     | 2fe30f1..b2108b3  | **fail**: Diff truncated; `files_changed` only 2 files (App.tsx, .env.example); can’t verify full checklist |
| 5     | b2108b3..a068c79  | **fail**: Same: diff truncated; `files_changed` only 2 files; checklist not verifiable |
| 6     | a068c79..ac847d3  | **fail**: Same pattern; then workflow closed task (max rounds) |

So the branch **did** progress (more files over time), but the reviewer kept failing because it couldn’t see enough of the PR.

## Root causes

### 1. Planner re-running every time (fixed in code)

After each **fail**, the workflow re-ran the full LangGraph with `reviewer_feedback` set. The graph **still started at the Planner** (entry point was always Planner), so the Planner produced a **new** checklist every time instead of reusing the previous one. That led to:

- Wasted LLM time and possible plan churn.
- Implementer sometimes “starting over” instead of only addressing the reviewer’s specific points.

**Fix (already in place):** When `reviewer_feedback` is set we now:

- Skip the Planner and go straight to the Implementer.
- Load the existing checklist (and implementer summary) from `task_result.json`.

So on re-runs, the Implementer keeps the same plan and only gets the reviewer’s feedback to address.

### 2. PR diff truncated for the Reviewer LLM

The Reviewer is given the PR body + **PR diff**. The diff is currently truncated to **12,000 characters** (first 6k + last 6k) in `worker/langgraph_runner.py`:

```python
if len(pr_diff) > 12000:
    pr_diff = pr_diff[:6000] + "\n...(truncated)...\n" + pr_diff[-6000:]
```

A scaffolding PR (Vite, Tailwind, Vitest, Playwright, many config files) easily exceeds that. The Reviewer then says things like “the diff is truncated” and “files_changed only shows 2 files” and correctly refuses to pass because it **cannot** verify the full checklist.

**Fix:** Increase the diff limit (e.g. to 60k–80k) so typical scaffolding PRs fit in one review context.

### 3. `files_changed` in `task_result.json` is incomplete

`files_changed` is taken only from the Implementer’s **write_file** tool calls. It does **not** include:

- Files created by **run_command** (e.g. `npm create vite`, or generated configs).
- Every file the Implementer actually changed if it didn’t report them all via tools.

So the Reviewer sees a short `files_changed` list (e.g. 2 files) and a truncated diff, and reasonably concludes the implementation is incomplete.

**Fix:** When writing `task_result.json`, optionally enrich `files_changed` with `git diff --name-only` (or similar) from the workspace so the list reflects all changed files in the branch. That doesn’t replace the diff, but gives the Reviewer a correct list of modified files.

## Commits on the T1 branch (Gitea)

```
ac847d3 [T1] implementation
a068c79 [T1] implementation
b2108b3 [T1] implementation
2fe30f1 [T1] implementation
4582219 [T1] implementation
c75b775 [T1] implementation
21c56f0 Initial commit
```

So the **codebase did improve** over the 6 implementer runs (each push added/fixed more), but the Reviewer kept failing because of **truncated diff** and **incomplete files_changed**, not necessarily because the implementation was still wrong.

## Recommendations

1. **Deploy the existing fix:** Ensure the worker is rebuilt/restarted so that on re-run we **skip the Planner** and **load checklist from task_result.json**. That way the Implementer only addresses reviewer feedback.
2. **Increase PR diff limit** in `review_pr_content` (e.g. to 60k–80k) so the Reviewer can see the full diff for large PRs.
3. **Enrich `files_changed`** from git in the workspace when saving `task_result.json` (or in the review path) so the Reviewer sees the full list of changed files.
4. Optionally **increase max review rounds** for complex tickets like T1 (scaffolding has many acceptance criteria), or surface “max rounds reached” in the UI so the user knows the run stopped due to limit, not necessarily because the implementation is bad.
