# Analysis: Why the Repo Only Has the React Vite Template

## Why nothing happened in the last run (empty workspace → still empty, all tickets Done)

You emptied the workspace and ran with OpenRouter (z-ai/glm-5). T85–T89 all went to **Done**, but the workspace stayed **empty** (no `package.json`, no app).

**What the pipeline did:**

1. **Planner** – One LLM call (no tools). It succeeded (OpenRouter 200). The model returned a text checklist.
2. **Implementer** – One LLM call *with* tools (`read_file`, `write_file`, `run_command`). The model is supposed to return **tool_calls** (e.g. `write_file("package.json", "...")`). Our code only writes files when the response contains `tool_calls` and we execute each one.
3. **Reviewer** – Saw “Files edited: ” (empty) because no tools were run, said “fail”. We allow at most 2 rounds then **force pass**.
4. **run_tests** – No `package.json` → “No test runner found”. We still upload the log and continue.
5. **close_task** – Ticket set to Done.

So **nothing happened** because the **implementer never ran any tools**. The most likely reason is that **z-ai/glm-5 did not return structured tool_calls** in the implementer step. Many models return plain text (“I will create package.json…”) instead of the JSON structure LangChain expects for tool use. When `out.tool_calls` is empty, we never call `write_file` or `run_command`, so no files are created and the workspace stays empty. We still force pass after 2 rounds and close the ticket, so all five tickets went Done with zero code.

**How to confirm:** Run the worker again and watch logs. We now log: `Implementer returned no tool_calls` when the model doesn’t return tools, or `Implementer returned N tool_calls: [write_file, ...]` when it does. If you always see “no tool_calls”, switch to a model that supports function/tool calling (e.g. OpenRouter’s `openai/gpt-4o` or a model listed as supporting tools) or add a fallback that parses the model’s text and writes files from it.

---

## What you have vs what was requested

| Ticket | Requested | What’s in the repo |
|--------|-----------|---------------------|
| **T80** | Vite + React + TS, `src/components`, `src/hooks`, App with “Task Manager” placeholder | Default Vite template: `App.tsx` with “Vite + React”, count button, logos. No `src/components`, no `src/hooks`, no “Task Manager” heading |
| **T81** | Task list, Task type, in-memory state, TaskList component, sample tasks | (unchanged – still default template) |
| **T82** | Add-task form (input + button, validation, unique id) | (unchanged) |
| **T83** | Toggle complete, delete task | (unchanged) |
| **T84** | Filter: All / Active / Completed | (unchanged) |

So only the initial scaffold (Vite template) exists; none of the task-manager behavior was implemented.

---

## How the pipeline works

1. **Task spec**  
   For each ticket, `_build_task_spec()` builds a markdown spec from title, description, acceptance criteria, and test plan. That string is what the LLM sees.

2. **LangGraph (Execute)**  
   - **Planner**: One LLM call; returns a short checklist (plain text, no tools).  
   - **Implementer**: One LLM call with tools: `read_file`, `write_file`, `run_command`. The model can return **tool_calls**; the runner executes them and records which files were written.  
   - **Reviewer**: One LLM call; returns one word: pass / fail / risky.  
   - **Loop**: If reviewer says “fail”, we go back to the implementer (max **2 rounds**). After 2 rounds we **force pass** and exit.  
   - **Risky**: If reviewer says “risky”, we used to wait for human approval; with `skip_pr` we now auto-approve and continue.

3. **Workspace path**  
   With `WORKSPACE_PATH`, the workspace is the repo root (e.g. `factory-workspace-1`). The app lives under `task-manager-react/`. So the implementer must use paths like `task-manager-react/src/App.tsx` when calling `write_file`.

4. **Success criteria for the run**  
   With `skip_pr`, we always run tests and close the ticket (run_tests → close_task). We do **not** require that the implementer actually changed files. So a ticket can go to Done with **no edits** or only the template.

---

## What actually happened

### 1. T80: How you got the template (and only the template)

- The **first** Execute run for T80 had an empty (or fresh) workspace.
- The planner likely produced steps like “create Vite project”, “add folder structure”, “add Task Manager heading”.
- The implementer almost certainly used **`run_command`** to run something like `npm create vite@latest task-manager-react -- --template react-ts`, which creates the **default** Vite + React + TypeScript app (the one you see now).
- That gives you `task-manager-react/` with the stock `App.tsx` (Vite + React logos, count button), and no `src/components` or `src/hooks`.
- In the same round (or next), the implementer would need to **edit** `task-manager-react/src/App.tsx` and create `src/components`, `src/hooks`, etc. That requires **`write_file`** tool_calls.
- So either:
  - The model **did not emit** `write_file` tool_calls (only `run_command`), so no customizations were applied, or  
  - It did emit them but they failed (e.g. wrong path, exception swallowed in the runner), or  
  - The reviewer said “pass” or “risky” after the scaffold step and we stopped before further edits.

So T80 ended up as “Vite template created, no task-manager-specific code”.

### 2. T81–T84: Why no task list, form, toggle, delete, or filter

- For each of these, the task_spec clearly asked for new behavior (task list, form, toggle, delete, filter).
- Implementing that requires the model to **call** `read_file` (e.g. on `task-manager-react/src/App.tsx`) and then **call** `write_file` with modified or new files (e.g. `App.tsx`, `TaskList.tsx`, `AddTaskForm.tsx`, etc.).
- **Observed**: `task_result.json` shows `files_changed: []` and `pass: false`. So in at least one run, the implementer **wrote no files** and the reviewer said “fail”.
- Most plausible explanation: **the model (e.g. Qwen on LM Studio) is not returning structured tool_calls** in the implementer step. Many local/smaller models:
  - Don’t support tool/function calling, or  
  - Return plain text (“I will write …”) instead of actual `write_file` invocations.  
  So the runner never sees `tool_calls`, never runs `write_file`, and `current_file_edits` stays empty.
- The reviewer then sees “Files edited: ” (empty) and reasonably says “fail”. We do at most 2 rounds and then **force pass**, then run_tests and close_task. So T81–T84 were marked **Done** even though **no code was added**; the app stayed the default template.

### 3. Summary of causes

| Cause | Effect |
|--------|--------|
| **Implementer uses only `run_command` for T80** | You get the default Vite scaffold, but no follow-up edits to match the spec (Task Manager heading, components, hooks). |
| **Model doesn’t emit `write_file` tool_calls** | No file edits for T81–T84; `files_changed` stays empty. |
| **Max 2 rounds + force pass** | We accept “done” after 2 rounds even when the reviewer said “fail”, so we don’t retry until real edits happen. |
| **No gate on “real” progress** | With `skip_pr`, we always run tests and close; we don’t require `files_changed` or a passing reviewer to consider the ticket successful. |

---

## What to change (concrete)

1. **Verify tool use**  
   - Log the implementer’s LLM response: does it contain `tool_calls`? How many are `write_file`?  
   - If the model never returns tool_calls, either:  
     - Use a model that supports tool/function calling (e.g. via OpenRouter), or  
     - Add a fallback: parse the model’s text for “write file X with content Y” (or code blocks) and call `write_file` from that.

2. **Make the implementer multi-step**  
   - Right now the implementer is a single LLM call per round. For “read App.tsx, then write App.tsx and TaskList.tsx” the model may need to see the result of `read_file` and then issue `write_file` in a **second** call.  
   - Consider an agent loop: implementer → execute tool_calls → append results to messages → implementer again, until the model says “done” or you hit a step limit.

3. **Don’t force pass when nothing was edited**  
   - If after 2 rounds `current_file_edits` is still empty (and the task_spec required code changes), treat as failure: don’t force pass, block or retry the ticket so the run doesn’t close with no app code.

4. **Optional: Require “real” success when skip_pr**  
   - e.g. Only run_tests and close_task if either the reviewer said “pass” or `files_changed` is non-empty (or both). That way you don’t mark tickets Done when nothing was implemented.

5. **T80-specific**  
   - If you keep using “create via CLI then edit”, make the checklist explicit: “1. Run npm create vite … 2. Write task-manager-react/src/App.tsx with … 3. Create task-manager-react/src/components/….”  
   - Or scaffold via tools only (implementer writes `package.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, etc.) so the first run doesn’t depend on the default template.

---

## Short answer

- You have only the Vite template because **T80** most likely created the app with a **shell command** (e.g. `npm create vite`), which produces the default template, and no **file edits** were applied (no or wrong `write_file` tool_calls).
- **T81–T84** added no code because the implementer step almost certainly produced **no `write_file` tool_calls** (model not using tools or not supported), so the reviewer saw no edits, said “fail”, and we **forced pass after 2 rounds** and closed the tickets anyway.
- So the repo never got past the default Vite template because the pipeline never applied real, tool-based edits for the task-manager features.
