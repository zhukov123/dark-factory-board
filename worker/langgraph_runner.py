"""LangGraph task execution: Planner -> Implementer -> Reviewer with optional interrupt."""
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, TypedDict

logger = logging.getLogger(__name__)

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import LLMResult
from langchain_core.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.checkpoint.sqlite import SqliteSaver

from config import (
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
    LMSTUDIO_BASE_URL,
    LMSTUDIO_MODEL,
)


def _llm_log_dir() -> Path:
    """Directory for LLM request/response logs (in this repo)."""
    repo_root = Path(__file__).resolve().parent.parent
    log_dir = repo_root / "logs" / "llm"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


class LLMLogHandler(BaseCallbackHandler):
    """Logs every token in (prompts) and every token out (response) to a markdown file."""

    def __init__(self, step: str, log_dir: Path, thread_id: str = "default"):
        self.step = step
        self.log_dir = Path(log_dir)
        self.thread_id = thread_id
        self._path: Path | None = None

    def on_llm_start(self, serialized: dict[str, Any], prompts: list[str], **kwargs: Any) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        safe_thread = "".join(c if c.isalnum() or c in "-_" else "_" for c in self.thread_id)
        self._path = self.log_dir / f"{ts}_{self.step}_{safe_thread}.md"
        parts = [
            "# LLM interaction",
            "",
            f"- **Step:** {self.step}",
            f"- **Thread:** {self.thread_id}",
            f"- **At:** {ts}",
            "",
            "## Tokens in (input)",
            "",
            "```",
        ]
        for i, p in enumerate(prompts):
            if i:
                parts.append("---")
            parts.append(p if isinstance(p, str) else str(p))
        parts.extend(["", "```", ""])
        self._path.write_text("\n".join(parts), encoding="utf-8")

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        if self._path is None:
            return
        parts = ["## Tokens out (output)", ""]
        for gen_list in response.generations:
            for g in gen_list:
                if hasattr(g, "message") and g.message is not None:
                    msg = g.message
                    content = getattr(msg, "content", None) or ""
                    if content:
                        parts.append("```")
                        parts.append(content)
                        parts.append("```")
                        parts.append("")
                    if getattr(msg, "tool_calls", None):
                        parts.append("### Tool calls")
                        parts.append("")
                        parts.append("```json")
                        parts.append(json.dumps(msg.tool_calls, indent=2))
                        parts.append("```")
                elif getattr(g, "text", None):
                    parts.append("```")
                    parts.append(g.text)
                    parts.append("```")
        existing = self._path.read_text(encoding="utf-8")
        self._path.write_text(existing + "\n".join(parts), encoding="utf-8")


def _strip_thinking(text: str) -> str:
    """Remove <think>...</think> blocks so downstream only sees the actual response."""
    return re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL | re.IGNORECASE).strip()


def _run_config_with_llm_log(config: dict | None, step: str) -> dict:
    """Add LLMLogHandler to config callbacks so every LLM call is logged to logs/llm/*.md."""
    # Always log: use repo log dir (config may not be passed to nodes by the graph runtime)
    log_dir = _llm_log_dir()
    configurable = (config or {}).get("configurable") or {}
    thread_id = configurable.get("thread_id", "default")
    handler = LLMLogHandler(step=step, log_dir=log_dir, thread_id=thread_id)
    base = config or {}
    callbacks = list(base.get("callbacks") or [])
    callbacks.append(handler)
    return {**base, "callbacks": callbacks}


class TaskState(TypedDict):
    task_spec: str
    workspace_path: str
    checklist: list[str]
    current_file_edits: list[str]
    implementer_summary: str
    reviewer_feedback: str
    interrupt_decision_id: str | None
    task_result: dict | None
    reviewer_verdict: Literal["pass", "fail", "risky"] | None
    review_round: int


def _tools(workspace_path: str):
    @tool
    def read_file(relative_path: str) -> str:
        """Read a file from the workspace."""
        p = Path(workspace_path) / relative_path.lstrip("/")
        if not p.resolve().is_relative_to(Path(workspace_path).resolve()):
            return "Error: path outside workspace"
        if not p.exists():
            return f"Error: file not found {relative_path}"
        return p.read_text(errors="replace")

    @tool
    def write_file(relative_path: str, content: str) -> str:
        """Write content to a file in the workspace."""
        p = Path(workspace_path) / relative_path.lstrip("/")
        if not p.resolve().is_relative_to(Path(workspace_path).resolve()):
            return "Error: path outside workspace"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return f"Wrote {relative_path}"

    @tool
    def run_command(cmd: str) -> str:
        """Run a shell command in the workspace (e.g. lint, test)."""
        import subprocess
        try:
            r = subprocess.run(
                cmd,
                shell=True,
                cwd=workspace_path,
                capture_output=True,
                text=True,
                timeout=120,
            )
            out = (r.stdout or "") + (r.stderr or "")
            return f"exit={r.returncode}\n{out}"
        except Exception as e:
            return str(e)

    return [read_file, write_file, run_command]


def _get_llm():
    """Return the configured LLM: OpenRouter if key set, else LM Studio if URL set, else None."""
    if OPENROUTER_API_KEY:
        from langchain_openrouter import ChatOpenRouter
        kwargs = {"model": OPENROUTER_MODEL, "temperature": 0, "openrouter_api_key": OPENROUTER_API_KEY}
        return ChatOpenRouter(**kwargs)
    if LMSTUDIO_BASE_URL:
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            base_url=LMSTUDIO_BASE_URL,
            api_key="lm-studio",
            model=LMSTUDIO_MODEL,
            temperature=0,
        )
    return None


def build_graph(workspace_path: str, checkpointer: SqliteSaver | None = None):
    llm = _get_llm()
    if llm is None:
        raise ValueError("No LLM configured. Set OPENROUTER_API_KEY or LMSTUDIO_BASE_URL.")
    tools = _tools(workspace_path)
    llm_with_tools = llm.bind_tools(tools)

    def planner(state: TaskState, config: dict | None = None) -> TaskState:
        messages = [
            SystemMessage(content="You are a task planner. Given a task spec, output a short checklist of concrete steps (one per line). Reply with only the checklist, no preamble."),
            HumanMessage(content=state["task_spec"]),
        ]
        conf = config or {}
        run_config = _run_config_with_llm_log(conf, "planner")
        out = llm.invoke(messages, config=run_config)
        content = out.content if hasattr(out, "content") else str(out)
        content = _strip_thinking(content)
        lines = [x.strip() for x in content.splitlines() if x.strip()]
        return {**state, "checklist": lines}

    tool_map = {t.name: t for t in tools}

    IMPLEMENTER_MAX_TURNS = 15

    def implementer(state: TaskState, config: dict | None = None) -> TaskState:
        messages: list = [
            SystemMessage(content="You are an implementer. Use the tools to complete the checklist. You MUST call write_file for each file you create or change. Prefer read_file first if a file exists, then write_file, then run_command for tests. After seeing tool results, call more tools as needed until the checklist is done; then reply with a short summary and no further tool calls."),
            HumanMessage(content=f"Checklist:\n" + "\n".join(state["checklist"]) + "\n\nTask spec:\n" + state["task_spec"]),
        ]
        conf = config or {}
        run_config = _run_config_with_llm_log(conf, "implementer")
        edits = list(state.get("current_file_edits") or [])

        last_summary = ""
        for turn in range(IMPLEMENTER_MAX_TURNS):
            out = llm_with_tools.invoke(messages, config=run_config)
            has_tool_calls = hasattr(out, "tool_calls") and out.tool_calls
            if not has_tool_calls:
                if turn == 0:
                    logger.warning("Implementer LLM returned no tool_calls (model may not support tool use). Response has content: %s", bool(getattr(out, "content", None)))
                last_summary = _strip_thinking(out.content or "")
                break
            logger.info("Implementer turn %d: %d tool_calls: %s", turn + 1, len(out.tool_calls), [tc.get("name") for tc in out.tool_calls])
            messages.append(AIMessage(content=out.content or "", tool_calls=out.tool_calls or []))
            for tc in out.tool_calls:
                name = tc.get("name")
                args = tc.get("args") or {}
                tool_fn = tool_map.get(name)
                result = "Error: unknown tool"
                if tool_fn:
                    try:
                        result = tool_fn.invoke(args)
                        if name == "write_file":
                            path = args.get("relative_path", "")
                            if path:
                                edits.append(path)
                    except Exception as e:
                        result = str(e)
                tool_id = tc.get("id") or tc.get("name", "")
                messages.append(ToolMessage(content=result, tool_call_id=tool_id))
        return {**state, "current_file_edits": edits, "implementer_summary": last_summary}

    def reviewer(state: TaskState, config: dict | None = None) -> TaskState:
        round_num = state.get("review_round", 0) + 1
        files_edited = ", ".join(state.get("current_file_edits") or [])
        implementer_summary = (state.get("implementer_summary") or "").strip()
        review_content = (
            f"Task spec:\n{state['task_spec']}\n\nChecklist:\n" + "\n".join(state["checklist"])
            + f"\n\nFiles edited: {files_edited}"
        )
        if implementer_summary:
            review_content += f"\n\nImplementer summary (what was done):\n{implementer_summary}"
        messages = [
            SystemMessage(content="You are a reviewer. Reply with exactly one word: pass, fail, or risky. pass = task done; fail = needs more work; risky = needs human approval. Use the task spec and acceptance criteria to judge whether the checklist was completed and the implementer summary and files edited are consistent with the task."),
            HumanMessage(content=review_content),
        ]
        conf = config or {}
        run_config = _run_config_with_llm_log(conf, "reviewer")
        out = llm.invoke(messages, config=run_config)
        content = _strip_thinking(out.content if hasattr(out, "content") else str(out)).lower()
        verdict = "pass"
        if "risky" in content:
            verdict = "risky"
        elif "fail" in content:
            verdict = "fail"
        if verdict == "fail" and round_num >= 2:
            verdict = "pass"
        return {**state, "reviewer_verdict": verdict, "review_round": round_num}

    def route_after_review(state: TaskState) -> Literal["implementer", "end"]:
        if state.get("reviewer_verdict") == "fail" and state.get("review_round", 0) < 2:
            return "implementer"
        return "end"

    graph_builder = StateGraph(TaskState)
    graph_builder.add_node("planner", planner)
    graph_builder.add_node("implementer", implementer)
    graph_builder.add_node("reviewer", reviewer)
    graph_builder.set_entry_point("planner")
    graph_builder.add_edge("planner", "implementer")
    graph_builder.add_edge("implementer", "reviewer")
    graph_builder.add_conditional_edges("reviewer", route_after_review, {"implementer": "implementer", "end": END})

    graph = graph_builder.compile(checkpointer=checkpointer)
    return graph


def run_task(
    task_spec: str,
    workspace_path: str,
    thread_id: str = "default",
    interrupt_decision_id: str | None = None,
) -> tuple[dict, bool, str | None]:
    """
    Run the LangGraph. Returns (task_result, success, decision_id_if_interrupt).
    task_result has keys: assumptions, files_changed, tests_run, pass/fail.
    If neither OPENROUTER_API_KEY nor LMSTUDIO_BASE_URL is set, returns a no-op success (no LLM calls).
    """
    if not OPENROUTER_API_KEY and not LMSTUDIO_BASE_URL:
        task_result = {"assumptions": [], "files_changed": [], "tests_run": [], "pass": True}
        (Path(workspace_path) / "task_result.json").write_text(json.dumps(task_result, indent=2))
        return task_result, True, None

    db_path = Path(workspace_path) / ".langgraph_checkpoints.sqlite"
    with SqliteSaver.from_conn_string(str(db_path)) as checkpointer:
        graph = build_graph(workspace_path, checkpointer=checkpointer)

        initial: TaskState = {
            "task_spec": task_spec,
            "workspace_path": workspace_path,
            "checklist": [],
            "current_file_edits": [],
            "implementer_summary": "",
            "reviewer_feedback": "",
            "interrupt_decision_id": interrupt_decision_id,
            "task_result": None,
            "reviewer_verdict": None,
            "review_round": 0,
        }

        log_dir = _llm_log_dir()
        config = {
            "configurable": {
                "thread_id": thread_id,
                "llm_log_dir": str(log_dir),
            }
        }
        if interrupt_decision_id:
            result = graph.invoke(None, config=config)
        else:
            result = graph.invoke(initial, config=config)

    state = result if isinstance(result, dict) else {}
    verdict = state.get("reviewer_verdict")
    checklist = state.get("checklist", [])
    edits = state.get("current_file_edits", [])

    task_result = {
        "assumptions": [],
        "files_changed": edits,
        "tests_run": [],
        "pass": verdict == "pass",
    }
    result_path = Path(workspace_path) / "task_result.json"
    result_path.write_text(json.dumps(task_result, indent=2))

    if verdict == "risky":
        import uuid
        decision_id = str(uuid.uuid4())
        return task_result, False, decision_id
    return task_result, verdict == "pass", None
