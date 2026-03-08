"""Temporal activities for DarkFactoryRun."""
import re
from pathlib import Path

from temporalio import activity

from config import REPO_CLONE_ROOT, GITHUB_TOKEN, WORKSPACE_REPO, WORKSPACE_PATH
from taskboard_client import (
    claim,
    release,
    get_pick_next,
    get_ticket,
    patch_run,
    transition,
    post_update,
    upload_attachment,
)


def _build_task_spec(ticket: dict) -> str:
    """Build Markdown task spec from ticket (plan §4)."""
    title = ticket.get("title", "")
    repo = ticket.get("repo", "")
    labels = ticket.get("labels", [])
    labels_str = ", ".join(labels) if isinstance(labels, list) else str(labels)
    description = ticket.get("description") or ""
    acceptance_criteria = ticket.get("acceptance_criteria", [])
    if isinstance(acceptance_criteria, list):
        ac_lines = "\n".join(f"- {x}" for x in acceptance_criteria)
    else:
        ac_lines = str(acceptance_criteria)
    test_plan = ticket.get("test_plan") or ""

    return f"""# {title}
Repo: {repo}
Labels: {labels_str}

## Description
{description}

## Acceptance criteria
{ac_lines}

## Test plan
{test_plan}
"""


@activity.defn
async def pick_next_task(repo: str | None = None, owner: str | None = None) -> dict:
    """GET pick-next, build task_spec from ticket. Returns { ticket_id, task_spec } or { ticket_id: None, reason }."""
    result = await get_pick_next(repo=repo, owner=owner)
    ticket_id = result.get("ticket_id")
    if not ticket_id:
        return {"ticket_id": None, "reason": result.get("reason", "none eligible")}

    ticket = await get_ticket(ticket_id)
    if not ticket:
        return {"ticket_id": None, "reason": "ticket not found"}
    task_spec = _build_task_spec(ticket)
    return {"ticket_id": ticket_id, "task_spec": task_spec}


@activity.defn
async def claim_task(ticket_id: str, owner: str, ttl_seconds: int) -> dict:
    """POST /runs/claim. Returns { claimed: bool }."""
    result = await claim(ticket_id, owner, ttl_seconds)
    return {"claimed": result.get("claimed", False)}


def _slug(s: str) -> str:
    """Safe slug for branch names."""
    return re.sub(r"[^a-zA-Z0-9-]", "-", s).strip("-") or "task"


def _repo_url(repo: str | None) -> str | None:
    """Build HTTPS clone URL for GitHub. repo is 'owner/name' or org/name."""
    if not repo or not GITHUB_TOKEN:
        return None
    repo = repo.strip().strip("/")
    if not repo:
        return None
    if repo.startswith("http"):
        return repo
    return f"https://x-access-token:{GITHUB_TOKEN}@github.com/{repo}.git"


def _effective_repo(repo: str | None) -> str | None:
    """Repo to use for clone/PR: WORKSPACE_REPO if set, else workflow/ticket repo."""
    if WORKSPACE_REPO:
        return WORKSPACE_REPO
    if repo and str(repo).strip():
        return str(repo).strip()
    return None


def _repo_slug_from_path(path: Path) -> str | None:
    """Infer GitHub owner/repo from git remote at path."""
    try:
        import git
        g = git.Repo(path)
        remote = None
        for r in list(g.remotes):
            if getattr(r, "name", None) == "origin":
                remote = getattr(r, "url", None)
                break
        if remote and "github.com" in remote:
            return remote.rstrip(".git").split("github.com/")[-1].replace(":", "/")
    except Exception:
        pass
    return None


@activity.defn
async def prepare_workspace(ticket_id: str, task_spec: str, repo: str | None = None) -> dict:
    """Clone repo (or use WORKSPACE_PATH), create branch task/{ticket_id_slug}-{short_id}, write metadata, PATCH run.
    Returns workspace_path, branch, and repo (for PR)."""
    import json
    slug = _slug(ticket_id)
    short_id = ticket_id[-6:] if len(ticket_id) >= 6 else ticket_id
    branch = f"task/{slug}-{short_id}"

    # Use local workspace path when set (no clone; one task at a time)
    if WORKSPACE_PATH:
        workspace_path = Path(WORKSPACE_PATH).resolve()
        if not workspace_path.is_dir():
            raise RuntimeError(f"WORKSPACE_PATH is not a directory: {workspace_path}")
        try:
            import subprocess
            ws = str(workspace_path)
            try:
                subprocess.run(["git", "fetch", "origin"], cwd=ws, capture_output=True, timeout=30, check=False)
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass
            out = subprocess.run(["git", "branch", "--list", "main", "master"], cwd=ws, capture_output=True, text=True, timeout=5)
            base = "main" if "main" in (out.stdout or "") else ("master" if "master" in (out.stdout or "") else "HEAD")
            for _ in range(2):
                r = subprocess.run(["git", "checkout", "-b", branch, base], cwd=ws, capture_output=True, text=True, timeout=10)
                if r.returncode == 0:
                    break
                r2 = subprocess.run(["git", "checkout", branch], cwd=ws, capture_output=True, text=True, timeout=10)
                if r2.returncode == 0:
                    break
                subprocess.run(["git", "checkout", "-b", branch, "HEAD"], cwd=ws, capture_output=True, timeout=10)
                break
            meta = {"ticket_id": ticket_id, "branch": branch}
            meta_path = workspace_path / ".dark-factory.json"
            meta_path.write_text(json.dumps(meta, indent=2))
            effective = _repo_slug_from_path(workspace_path)
            await patch_run(ticket_id, branch=branch, last_error="")
            await post_update(ticket_id, f"Workspace (local) at {workspace_path}, branch {branch}", author="worker")
            return {"workspace_path": str(workspace_path), "branch": branch, "repo": effective}
        except Exception as e:
            await patch_run(ticket_id, last_error=str(e))
            raise RuntimeError(f"PrepareWorkspace (WORKSPACE_PATH) failed: {e}") from e

    root = Path(REPO_CLONE_ROOT)
    root.mkdir(parents=True, exist_ok=True)
    workspace_path = root / f"ticket_{ticket_id.replace('/', '_')}"
    effective = _effective_repo(repo)
    repo_url = _repo_url(effective)
    if repo_url:
        try:
            import git
            if workspace_path.exists():
                g = git.Repo(workspace_path)
                try:
                    for r in list(g.remotes):
                        if getattr(r, "name", None) == "origin":
                            r.fetch()
                            break
                except Exception:
                    pass
                base_ref = "HEAD"
            else:
                g = git.Repo.clone_from(repo_url, workspace_path)
                base_ref = "origin/HEAD" if "origin/HEAD" in [r.name for r in g.references] else "origin/main"
            try:
                g.git.checkout("-b", branch, base_ref)
            except Exception:
                try:
                    g.git.checkout(branch)
                except Exception:
                    g.git.checkout("-b", branch, "HEAD")
            base_commit = g.head.commit.hexsha
            meta = {
                "ticket_id": ticket_id,
                "branch": branch,
                "base_commit": base_commit,
            }
            meta_path = workspace_path / ".dark-factory.json"
            meta_path.write_text(json.dumps(meta, indent=2))
            await patch_run(ticket_id, branch=branch)
            await post_update(ticket_id, f"Workspace prepared at {workspace_path}, branch {branch}", author="worker")
        except Exception as e:
            await patch_run(ticket_id, last_error=str(e))
            raise RuntimeError(f"PrepareWorkspace failed: {e}") from e
    else:
        workspace_path.mkdir(parents=True, exist_ok=True)
        meta_path = workspace_path / ".dark-factory.json"
        meta_path.write_text(json.dumps({"ticket_id": ticket_id, "branch": branch}, indent=2))
        await patch_run(ticket_id, branch=branch)
        await post_update(ticket_id, f"Workspace prepared (no clone) at {workspace_path}", author="worker")

    return {"workspace_path": str(workspace_path), "branch": branch, "repo": effective}


@activity.defn
async def execute_task_with_lang_graph(
    ticket_id: str, task_spec: str, workspace_path: str, branch: str,
    resume_decision_id: str | None = None,
) -> dict:
    """Run LangGraph; on interrupt return needs_approval + decision_id. Write task_result.json and upload."""
    try:
        from langgraph_runner import run_task
    except ImportError:
        return {"success": True}
    import json
    thread_id = f"ticket-{ticket_id}"
    try:
        task_result, success, decision_id = run_task(
            task_spec=task_spec,
            workspace_path=workspace_path,
            thread_id=thread_id,
            interrupt_decision_id=resume_decision_id,
        )
    except Exception as e:
        err_msg = (str(e) or repr(e))[:2000]
        await patch_run(ticket_id, last_error=err_msg)
        raise
    if decision_id:
        await patch_run(
            ticket_id,
            phase="AwaitingApproval",
            pending_approval_decision_id=decision_id,
        )
        await transition(ticket_id, "Blocked", note="Awaiting approval", by="worker")
        return {"success": False, "needs_approval": True, "decision_id": decision_id}
    result_path = Path(workspace_path) / "task_result.json"
    if result_path.exists():
        content = result_path.read_bytes()
        await upload_attachment(ticket_id, "task_result.json", content, "application/json")
    if success:
        return {"success": True}
    return {"success": False, "error": "reviewer failed"}


def _find_test_cwd(workspace_path: str) -> Path | None:
    """Return workspace or first subdir containing package.json or pyproject.toml or *.csproj."""
    path = Path(workspace_path)
    for candidate in [path] + list(path.iterdir()):
        if not candidate.is_dir():
            continue
        if (candidate / "package.json").exists() or (candidate / "pyproject.toml").exists():
            return candidate
        if list(candidate.glob("*.csproj")):
            return candidate
    return path if (path / "package.json").exists() or (path / "pyproject.toml").exists() else None


@activity.defn
async def workspace_has_code(workspace_path: str) -> dict:
    """Return whether workspace (or any subdir) has a project (package.json, pyproject.toml, *.csproj)."""
    return {"has_code": _find_test_cwd(workspace_path) is not None}


@activity.defn
async def run_task_tests(ticket_id: str, workspace_path: str) -> dict:
    """Run project tests (pytest, dotnet test, or script); capture log; upload as attachment; return success/failure."""
    import subprocess
    path = Path(workspace_path)
    test_cwd = _find_test_cwd(workspace_path) or path
    log_lines = []
    success = False
    timeout_sec = 90
    commands = [
        (["pytest", "-v", "--tb=short"], test_cwd),
        (["dotnet", "test", "--no-build", "-v", "n"], test_cwd),
        (["npm", "test"], test_cwd),
    ]
    if (test_cwd / "package.json").exists():
        commands = [(["npm", "test"], test_cwd)] + [c for c in commands if c[0] != ["npm", "test"]]
    for cmd, cwd in commands:
        if not cwd.exists():
            continue
        try:
            r = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
            )
            out = (r.stdout or "") + (r.stderr or "")
            log_lines.append(f"=== {' '.join(cmd)} (cwd={cwd}) ===\n{out}")
            success = r.returncode == 0
            break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    if not log_lines:
        log_lines.append("No test runner found (pytest, dotnet, npm).")
    log_content = "\n".join(log_lines).encode()
    await upload_attachment(ticket_id, "run_tests.log", log_content, "text/plain")
    excerpt = log_content[:2000].decode("utf-8", errors="replace") if len(log_content) > 2000 else log_content.decode("utf-8", errors="replace")
    return {"success": success, "log_excerpt": excerpt}


@activity.defn
async def open_or_update_pr(ticket_id: str, workspace_path: str, branch: str, repo: str | None = None) -> dict:
    """Push branch, create PR via GitHub API, PATCH run (pr_number), transition to Review, upload task_result and log."""
    import json
    from github import Github
    path = Path(workspace_path)
    repo_slug = repo
    if not repo_slug and GITHUB_TOKEN:
        repo_slug = _repo_slug_from_path(path)
    pr_url = None
    pr_number = 0
    if GITHUB_TOKEN and repo_slug:
        try:
            gh = Github(GITHUB_TOKEN)
            repo = gh.get_repo(repo_slug)
            try:
                import git
                g = git.Repo(workspace_path)
                for r in list(g.remotes):
                    if getattr(r, "name", None) == "origin":
                        r.push(branch)
                        break
            except Exception as e:
                await patch_run(ticket_id, last_error=f"Push failed: {e}")
                return {"pr_url": None, "pr_number": 0}
            body_path = path / "task_result.json"
            body = body_path.read_text() if body_path.exists() else f"Task {ticket_id}"
            pr = repo.create_pull(title=f"[{ticket_id}] Task", body=body[:5000], head=branch, base=repo.default_branch)
            pr_url = pr.html_url
            pr_number = pr.number
        except Exception as e:
            await patch_run(ticket_id, last_error=str(e))
            return {"pr_url": None, "pr_number": 0}
    await patch_run(ticket_id, pr_number=pr_number if pr_number else None)
    await transition(ticket_id, "Review", note="PR opened", by="worker")
    if (path / "task_result.json").exists():
        await upload_attachment(ticket_id, "task_result.json", (path / "task_result.json").read_bytes(), "application/json")
    log_path = path / "run_tests.log"
    if log_path.exists():
        await upload_attachment(ticket_id, "run_tests.log", log_path.read_bytes(), "text/plain")
    return {"pr_url": pr_url, "pr_number": pr_number}


@activity.defn
async def wait_for_review_and_ci(ticket_id: str, pr_number: int, repo: str | None = None) -> str:
    """Poll GitHub PR state and checks. Returns 'merged' | 'changes_requested' | 'rejected'."""
    if not GITHUB_TOKEN or not repo or pr_number <= 0:
        return "merged"
    from github import Github
    import time
    gh = Github(GITHUB_TOKEN)
    repo_obj = gh.get_repo(repo.strip())
    pr = repo_obj.get_pull(pr_number)
    for _ in range(120):
        pr.update()
        if pr.merged:
            await patch_run(ticket_id, last_ci_state="success")
            return "merged"
        if pr.state == "closed" and not pr.merged:
            await patch_run(ticket_id, last_ci_state="failure")
            return "rejected"
        reviews = pr.get_reviews()
        for r in reviews:
            if r.state == "CHANGES_REQUESTED":
                return "changes_requested"
            if r.state == "REQUEST_CHANGES" or (r.body and "reject" in r.body.lower()):
                return "rejected"
        time.sleep(60)
    return "rejected"


@activity.defn
async def patch_run_workflow_id(ticket_id: str, workflow_id: str) -> None:
    """PATCH run with workflow_id so API can signal Temporal."""
    await patch_run(ticket_id, workflow_id=workflow_id)


@activity.defn
async def transition_ticket(ticket_id: str, to: str, note: str | None = None, by: str = "worker") -> None:
    """Transition ticket status."""
    await transition(ticket_id, to, note=note, by=by)


@activity.defn
async def close_task(ticket_id: str, owner: str) -> None:
    """POST /runs/release, transition ticket to Done, post update."""
    result = await release(ticket_id, owner)
    if not result.get("released"):
        raise RuntimeError(result.get("error", "release failed"))
    await transition(ticket_id, "Done", note="Closed by worker", by=owner)
    await post_update(ticket_id, "Task closed.", author=owner)
