# T1 log analysis: why it doesn’t get it right the first time

## Data used

- **T1 events:** 85 (phases, verdicts, tool calls, file edits).
- **Planner checklist:** 18 items (Vite, Tailwind, Vitest, Playwright, dirs, App shell, scripts, tests, .env.example, verification).
- **Verdicts so far:** 2 × **fail** (reviewer), then re-run implementer with feedback.

---

## 1. What the reviewer said

**First PR (first run)**  
- Playwright not installed; no E2E infra.  
- Directory structure incomplete (missing `src/components`, `src/hooks`, `src/context`, `src/lib`, `src/styles`).  
- No Vitest unit tests, no E2E tests, no `.env.example`, no `test:e2e` script.  
- Vite, React 19, TypeScript strict, Tailwind v4, and App shell were present.

**Second PR (after one re-run with feedback)**  
- Vitest and Playwright are in place.  
- Directory structure still wrong: only `src/`, `src/assets/`, `src/test/`; required dirs still missing.  
- `App.tsx` still default Vite counter, not “centered placeholder”.  
- npm scripts still need verification.

So the first run does only part of the checklist; the second run fixes tests/Playwright but still misses dirs and App shell.

---

## 2. What the implementer actually did (first run)

From **tool calls** and **file edits** up to the first PR:

- **run_command:** `npm create vite@latest` (scaffold), `npm install`, Tailwind, Vitest + Testing Library + jsdom.
- **read_file:** `package.json`, `vite.config.ts`.
- **write_file:** only **2 files** — `vite.config.ts`, `src/index.css`.

So in the first run the implementer:

- Did **not** call `write_file` for: `App.tsx`, `.env.example`, any test file, or any file under `src/components`, `src/hooks`, etc.
- Did **not** run Playwright install or add `test:e2e`.
- Did **not** create the required directory structure (no writes under those dirs, and no explicit `mkdir`/empty-file creation visible in events).

So the first run fails because the implementer **stops well before completing the checklist**: it configures Vite/Tailwind/Vitest and touches two config files, but never creates the required dirs, never replaces App with the specified shell, and never adds Playwright, tests, or .env.example.

---

## 3. Why it doesn’t get it right the first time

### A. Checklist length and “done” too early

- The checklist has **18 items**. The implementer appears to treat “Vite + deps + Tailwind + Vitest” as a big chunk and then **stops or switches to summary** before doing:
  - Directory structure (item 6).
  - App shell (item 8).
  - Scripts (item 9).
  - Unit test (item 10).
  - Playwright + E2E (items 5, 11).
  - .env.example (item 12).
- So the model is **not** systematically ticking off every item before finishing. It gets partway and then ends the turn or considers the task “mostly done”.

### B. Default Vite template vs spec

- `npm create vite@latest` with `react-ts` gives a fixed layout: `App.tsx` (counter), `src/assets/`, etc. It does **not** create `src/components`, `src/hooks`, `src/context`, `src/lib`, `src/styles`.
- The implementer **relies on that default** and never:
  - Replaces `App.tsx` with a “centered placeholder” shell.
  - Creates the missing directories (e.g. via `write_file` for a file in each dir, or run_command `mkdir`).
- So “first time” is wrong because the spec is stricter than the default template and the implementer doesn’t explicitly fix the gaps.

### C. Tool mix: lots of run_command, few write_file

- Many steps are **run_command** (install, scaffold). Only **2 write_file** in the first run.
- Required deliverables (App shell, test files, .env.example, directory structure) all need **write_file** (or equivalent). The implementer never gets to those steps in the first run.
- So “not getting it right the first time” is partly: **incomplete execution** — the model plans/installs but doesn’t execute the full set of file-creation steps.

### D. Re-run improves tests, not structure

- After the first verdict, the implementer gets **reviewer feedback** and adds Playwright, Vitest usage, etc.
- The second verdict still complains about **directory structure** and **App.tsx** (counter vs placeholder). So either:
  - The feedback didn’t stress “create these exact dirs” and “replace App with a simple placeholder”, or
  - The implementer didn’t prioritize those in the next run.

So “not right the first time” is also: **re-run fixes some gaps (tests) but not others (structure, App)**.

### E. No explicit “create directory structure” step

- The checklist says “Create directory structure: src/components, …” but the tools are **read_file**, **write_file**, **run_command**. There is no dedicated “create empty dirs” tool.
- Creating a dir requires either:
  - `write_file` with a path like `src/components/.gitkeep` (or similar), or
  - `run_command` like `mkdir -p src/components src/hooks ...`.
- If the prompt doesn’t make this explicit, the model may not infer that it must create empty dirs and may skip “directory structure” or do it only partially.

---

## 4. Recommendations (concise)

1. **Planner / prompt:** Shorten or split the checklist so “create directory structure” and “replace App shell” are single, unambiguous steps (e.g. “Create empty dirs: src/components, src/hooks, …” and “Replace App.tsx with a centered placeholder only”).
2. **Implementer prompt:** Explicitly require “one write_file (or equivalent) per checklist item that involves a file or directory” and “do not stop until every checklist item is done”.
3. **Implementer tools:** Consider a **create_directory** (or “ensure directory”) tool, or document that `write_file` with a path in a new dir is the way to create dirs (e.g. `src/components/.gitkeep`).
4. **Reviewer feedback on re-run:** Ensure the feedback string includes **concrete missing items** (e.g. “Create src/components, src/hooks, … and replace App.tsx with a centered placeholder”) so the next implementer run addresses structure and App, not only tests.
5. **Single-run scope:** Consider splitting “T1” into two tickets: (1) Vite + Tailwind + Vitest + Playwright + scripts + one test, (2) Directory structure + App shell + .env.example. That reduces “first time” scope and makes it easier to get each part right.

These address the main reasons T1 doesn’t get it right the first time: **incomplete execution**, **template vs spec mismatch**, and **structure/App not emphasized in re-run feedback**.
