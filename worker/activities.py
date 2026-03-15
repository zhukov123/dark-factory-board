"""Temporal activities for DarkFactoryRun."""
import json
import logging
import re
import shutil
from pathlib import Path

from temporalio import activity

logger = logging.getLogger(__name__)

from config import REPO_CLONE_ROOT, GITHUB_TOKEN, GITEA_URL, GITEA_TOKEN, WORKSPACE_REPO, WORKSPACE_PATH, GITHUB_MERGE_METHOD, SKIP_HUMAN_APPROVAL, GITEA_COMMENT_MAX_CHARS
from taskboard_client import (
    claim,
    release,
    get_pick_next,
    get_ticket,
    patch_run,
    transition,
    post_update,
    upload_attachment,
    emit_event,
)


def _truncate_for_comment(body: str, max_chars: int | None = None) -> str:
    """Truncate body for Gitea/GitHub comments/reviews/PR descriptions.
    Uses GITEA_COMMENT_MAX_CHARS by default. If max_chars is 0, no truncation."""
    if max_chars is None:
        max_chars = GITEA_COMMENT_MAX_CHARS
    if max_chars == 0 or len(body) <= max_chars:
        return body
    return body[:max_chars] + "\n\n...(truncated)"


def _sanitize_url(url: str) -> str:
    """Hide token in URLs for logs and events (e.g. http://token@host -> http://***@host)."""
    if not url:
        return url
    try:
        from urllib.parse import urlparse, urlunparse
        p = urlparse(url)
        if p.username or p.password:
            netloc = p.hostname or ""
            if p.port:
                netloc += f":{p.port}"
            if p.username:
                netloc = "***@" + netloc
            p = p._replace(netloc=netloc)
            return urlunparse(p)
    except Exception:
        pass
    return re.sub(r"://[^@]+@", "://***@", url)


def _format_pr_body_from_task_result(tr: dict, ticket_id: str) -> str:
    """Build a readable Markdown PR description from task_result.json (not raw JSON)."""
    sections = []
    spec = (tr.get("task_spec") or "").strip()
    if spec:
        sections.append("## Task\n\n" + spec)
    checklist = tr.get("checklist") or []
    if checklist:
        sections.append("## Checklist\n\n" + "\n".join(f"- {item}" for item in checklist))
    summary = (tr.get("implementer_summary") or "").strip()
    if summary:
        sections.append("## Summary\n\n" + summary)
    files_changed = tr.get("files_changed") or []
    if files_changed:
        sections.append("## Files changed\n\n" + "\n".join(f"- `{f}`" for f in files_changed))
    if not sections:
        return f"Task {ticket_id}"
    return "\n\n---\n\n".join(sections)


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
    """GET pick-next, build task_spec from ticket. When repo is None/empty, API returns any eligible ticket; repo in result is the chosen ticket's repo. Returns { ticket_id, task_spec, repo? } or { ticket_id: None, reason }."""
    result = await get_pick_next(repo=repo, owner=owner)
    ticket_id = result.get("ticket_id")
    if not ticket_id:
        return {"ticket_id": None, "reason": result.get("reason", "none eligible")}

    ticket = await get_ticket(ticket_id)
    if not ticket:
        return {"ticket_id": None, "reason": "ticket not found"}
    task_spec = _build_task_spec(ticket)
    ticket_repo = ticket.get("repo") or None
    return {"ticket_id": ticket_id, "task_spec": task_spec, "repo": ticket_repo}


@activity.defn
async def claim_task(ticket_id: str, owner: str, ttl_seconds: int) -> dict:
    """POST /runs/claim. Returns { claimed: bool }."""
    result = await claim(ticket_id, owner, ttl_seconds)
    return {"claimed": result.get("claimed", False)}


def _slug(s: str) -> str:
    """Safe slug for branch names."""
    return re.sub(r"[^a-zA-Z0-9-]", "-", s).strip("-") or "task"


def _repo_url(repo: str | None) -> str | None:
    """Build HTTPS clone URL for Gitea or GitHub. repo is 'owner/name'."""
    if not repo:
        return None
    repo = repo.strip().strip("/")
    if not repo:
        return None
    if repo.startswith("http"):
        return repo
    if GITEA_URL and GITEA_TOKEN:
        base = GITEA_URL.rstrip("/").replace("http://", "").replace("https://", "")
        return f"http://{GITEA_TOKEN}@{base}/{repo}.git"
    if GITHUB_TOKEN:
        return f"https://x-access-token:{GITHUB_TOKEN}@github.com/{repo}.git"
    return None


def _effective_repo(repo: str | None) -> str | None:
    """Repo to use for clone/PR: WORKSPACE_REPO if set, else workflow/ticket repo."""
    if WORKSPACE_REPO:
        return WORKSPACE_REPO
    if repo and str(repo).strip():
        return str(repo).strip()
    return None


def _repo_slug_from_path(path: Path) -> str | None:
    """Infer owner/repo from git remote at path (GitHub or Gitea)."""
    try:
        import git
        g = git.Repo(path)
        remote = None
        for r in list(g.remotes):
            if getattr(r, "name", None) == "origin":
                remote = getattr(r, "url", None)
                break
        if not remote:
            return None
        if "github.com" in remote:
            return remote.rstrip(".git").split("github.com/")[-1].replace(":", "/").lstrip("/")
        if GITEA_URL and GITEA_URL.rstrip("/") in remote.replace("\\", "/"):
            # e.g. http://localhost:3000/owner/repo.git -> owner/repo
            base = GITEA_URL.rstrip("/")
            rest = remote.split(base)[-1].strip("/").rstrip(".git")
            return rest.replace(":", "/") if rest else None
    except Exception:
        pass
    return None


def _check_gitea_repo_and_ensure(repo_slug: str) -> None:
    """
    Test Gitea connectivity and repo access; create repo if 404. Raises RuntimeError with a clear
    message on failure (e.g. 401 Unauthorized, connection refused, create failed) for troubleshooting.
    """
    if not repo_slug or "/" not in repo_slug:
        return
    parts = repo_slug.split("/", 1)
    owner, name = parts[0], parts[1]
    if not GITEA_URL or not GITEA_TOKEN:
        return
    import httpx
    headers = {"Authorization": f"token {GITEA_TOKEN}"}
    base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"

    # 1. Test connectivity and token: GET /api/v1/user
    try:
        u = httpx.get(f"{GITEA_URL}/api/v1/user", headers=headers, timeout=10)
        if u.status_code == 401:
            raise RuntimeError(
                f"Gitea: 401 Unauthorized for {GITEA_URL}. Check GITEA_TOKEN is valid and has repo scope."
            )
        if u.status_code == 404:
            raise RuntimeError(
                f"Gitea: {GITEA_URL}/api/v1/user returned 404 — is GITEA_URL correct (e.g. http://gitea:3000)?"
            )
        if not u.is_success:
            raise RuntimeError(
                f"Gitea: unexpected response from {GITEA_URL}/api/v1/user: {u.status_code} {u.text[:200]}"
            )
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"Gitea: cannot connect to {GITEA_URL}. Is Gitea running and reachable from the worker? {e}"
        ) from e
    except httpx.TimeoutException as e:
        raise RuntimeError(
            f"Gitea: timeout connecting to {GITEA_URL}. Check URL and network. {e}"
        ) from e

    # 2. Test whether repo exists: GET /api/v1/repos/{owner}/{name}
    try:
        r = httpx.get(base_url, headers=headers, timeout=10)
        if r.status_code == 200:
            logger.info("Repo %s already exists, using it", repo_slug)
            return
        if r.status_code == 401:
            raise RuntimeError(
                f"Gitea: 401 Unauthorized accessing repo {repo_slug}. Check GITEA_TOKEN has repo read scope."
            )
        if r.status_code == 403:
            raise RuntimeError(
                f"Gitea: 403 Forbidden accessing repo {repo_slug}. Token may lack permission."
            )
        if r.status_code != 404:
            raise RuntimeError(
                f"Gitea: unexpected response for repo {repo_slug}: {r.status_code} {r.text[:200]}"
            )
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        raise RuntimeError(f"Gitea: failed to check repo {repo_slug}: {e}") from e

    # 3. Repo not found (404) — create it
    try:
        current_login = (u.json().get("login") or u.json().get("username") or "").strip()
    except Exception:
        current_login = ""
    create_url = (
        f"{GITEA_URL}/api/v1/user/repos"
        if (current_login and owner == current_login)
        else f"{GITEA_URL}/api/v1/orgs/{owner}/repos"
    )
    try:
        r2 = httpx.post(
            create_url,
            headers={**headers, "Content-Type": "application/json"},
            json={"name": name, "private": True},
            timeout=15,
        )
        if r2.status_code == 201 or r2.is_success:
            logger.info("Gitea: created repo %s", repo_slug)
            return
        if r2.status_code == 401:
            raise RuntimeError(
                f"Gitea: 401 Unauthorized creating repo {repo_slug}. Check GITEA_TOKEN."
            )
        if r2.status_code == 403:
            raise RuntimeError(
                f"Gitea: 403 Forbidden creating repo {repo_slug}. Token may lack create-repo permission or org access."
            )
        if r2.status_code == 404 and "orgs/" in create_url:
            raise RuntimeError(
                f"Gitea: 404 creating repo {repo_slug}. Org or user '{owner}' may not exist or token cannot create there."
            )
        raise RuntimeError(
            f"Gitea: failed to create repo {repo_slug}: {r2.status_code} {r2.text[:300]}"
        )
    except RuntimeError:
        raise
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        raise RuntimeError(f"Gitea: failed to create repo {repo_slug}: {e}") from e


def _ensure_repo_exists(repo_slug: str) -> None:
    """Ensure the repo exists on the host; use existing repo if present, create only if 404 (GitHub or Gitea). Raises on Gitea failure with clear error."""
    if not repo_slug or "/" not in repo_slug:
        return
    parts = repo_slug.split("/", 1)
    owner, name = parts[0], parts[1]
    if GITEA_URL and GITEA_TOKEN:
        _check_gitea_repo_and_ensure(repo_slug)
        return
    if GITHUB_TOKEN:
        from github import Github
        from github import UnknownObjectException
        gh = Github(GITHUB_TOKEN)
        try:
            gh.get_repo(repo_slug)
            return
        except UnknownObjectException:
            pass
        try:
            user = gh.get_user()
            if user.login == owner:
                user.create_repo(name, private=True, description="Dark Factory workspace")
            else:
                org = gh.get_organization(owner)
                org.create_repo(name, private=True, description="Dark Factory workspace")
        except Exception as e:
            logger.warning("GitHub ensure repo failed: %s", e)


def _short_run_guid() -> str:
    """8-char hex guid for branch/PR uniqueness."""
    import uuid
    return uuid.uuid4().hex[:8]


@activity.defn
async def prepare_workspace(ticket_id: str, task_spec: str, repo: str | None = None) -> dict:
    """Clone repo (or use WORKSPACE_PATH), create branch task/{ticket_id_slug}-{short_id}-{guid}, write metadata, PATCH run.
    Returns workspace_path, branch, and repo (for PR)."""
    logger.info("Prepare workspace started for %s", ticket_id)
    emit_event("worker.phase", ticket_id, {"phase": "prepare_workspace", "detail": "cloning repo & creating branch"})
    import json
    slug = _slug(ticket_id)
    short_id = ticket_id[-6:] if len(ticket_id) >= 6 else ticket_id
    run_guid = _short_run_guid()
    branch = f"task/{slug}-{short_id}-{run_guid}"

    # When WORKSPACE_PATH is set, use a per-ticket subdir under it (clean folder per ticket, same as clone path)
    root = Path(WORKSPACE_PATH).resolve() if WORKSPACE_PATH else Path(REPO_CLONE_ROOT)
    if root.exists() and not root.is_dir():
        raise RuntimeError(f"Workspace root is not a directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    workspace_path = root / f"ticket_{ticket_id.replace('/', '_')}"
    effective = _effective_repo(repo)
    if effective:
        logger.info("Ensuring repo exists: %s", effective)
        try:
            _ensure_repo_exists(effective)
        except RuntimeError as e:
            err = str(e)
            await patch_run(ticket_id, last_error=err)
            emit_event("worker.error", ticket_id, {"phase": "prepare_workspace", "message": err})
            raise RuntimeError(f"PrepareWorkspace (Gitea/repo check): {err}") from e
    repo_url = _repo_url(effective)
    logger.info("repo_url=%s workspace_path=%s", _sanitize_url(repo_url or ""), workspace_path)
    if effective:
        emit_event(
            "worker.debug",
            ticket_id,
            {
                "stage": "prepare_workspace_clone",
                "clone_url": _sanitize_url(repo_url or ""),
                "repo_slug": effective,
                "workspace_path": str(workspace_path),
                "branch": branch,
            },
        )
    if repo_url:
        try:
            import git
            # Clean new folder per ticket: remove existing dir so we always clone fresh
            if workspace_path.exists():
                logger.info("Removing existing workspace %s for fresh clone", workspace_path)
                shutil.rmtree(workspace_path)
            logger.info("Cloning %s -> %s", _sanitize_url(repo_url), workspace_path)
            g = git.Repo.clone_from(repo_url, workspace_path)
            refs = [r.name for r in g.references]
            logger.info("Clone done, refs=%s", refs)
            base_ref = "origin/HEAD" if "origin/HEAD" in refs else "origin/main"
            try:
                g.git.checkout("-b", branch, base_ref)
            except Exception:
                try:
                    g.git.checkout(branch)
                except Exception:
                    try:
                        g.git.checkout("-b", branch, "HEAD")
                    except Exception:
                        # Empty repo: bootstrap main branch first so PRs have a base
                        logger.info("Empty repo detected — bootstrapping main branch")
                        g.config_writer().set_value("user", "name", "worker").release()
                        g.config_writer().set_value("user", "email", "worker@local").release()
                        g.git.checkout("--orphan", "main")
                        (workspace_path / ".gitkeep").write_text("")
                        g.git.add(".gitkeep")
                        g.git.commit("-m", "Initial commit")
                        for r in list(g.remotes):
                            if getattr(r, "name", None) == "origin":
                                r.push("main")
                                logger.info("Pushed initial main branch to origin")
                                break
                        g.git.checkout("-b", branch, "main")
            base_commit = g.head.commit.hexsha
            meta = {
                "ticket_id": ticket_id,
                "branch": branch,
                "run_guid": run_guid,
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
        meta_path.write_text(json.dumps({"ticket_id": ticket_id, "branch": branch, "run_guid": run_guid}, indent=2))
        await patch_run(ticket_id, branch=branch)
        await post_update(ticket_id, f"Workspace prepared (no clone) at {workspace_path}", author="worker")

    logger.info("Prepare workspace finished for %s -> %s", ticket_id, workspace_path)
    emit_event("worker.phase", ticket_id, {"phase": "prepare_workspace", "detail": "done"})
    return {"workspace_path": str(workspace_path), "branch": branch, "repo": effective}


@activity.defn
async def execute_task_with_lang_graph(
    ticket_id: str,
    task_spec: str,
    workspace_path: str,
    branch: str,
    reviewer_feedback: str | None = None,
) -> dict:
    """Run LangGraph (Planner -> Implementer). Write task_result.json and upload. Review happens in review_pr activity."""
    logger.info("Execute (LangGraph) started for %s", ticket_id)
    # Same parameter is used for (1) PR reviewer fail/risky body and (2) build/test failure log
    is_review_feedback = reviewer_feedback and "Build or tests failed" not in (reviewer_feedback[:80] or "")
    if not reviewer_feedback:
        detail = "starting LangGraph"
    elif is_review_feedback:
        detail = "re-running with reviewer feedback"
    else:
        detail = "re-running with build/test feedback"
    emit_event("worker.phase", ticket_id, {"phase": "execute", "detail": detail})
    if reviewer_feedback:
        msg = (
            "Implementer receives the following reviewer feedback (from failed/risky PR review). Full prompt is in logs/llm/."
            if is_review_feedback
            else "Implementer receives build/test failure output to fix. Full prompt is in logs/llm/."
        )
        emit_event(
            "worker.debug",
            ticket_id,
            {
                "stage": "execute_implementer_input",
                "message": msg,
                "reviewer_feedback": reviewer_feedback[:4000] + ("…" if len(reviewer_feedback) > 4000 else ""),
            },
        )
    try:
        from langgraph_runner import run_task
    except ImportError:
        return {"success": True}
    build_test_hint = get_build_test_command_hint(workspace_path)
    thread_id = f"ticket-{ticket_id}"
    try:
        task_result, success = run_task(
            task_spec=task_spec,
            workspace_path=workspace_path,
            thread_id=thread_id,
            reviewer_feedback=reviewer_feedback,
            build_test_hint=build_test_hint,
        )
    except Exception as e:
        err_msg = (str(e) or repr(e))[:2000]
        await patch_run(ticket_id, last_error=err_msg)
        raise
    result_path = Path(workspace_path) / "task_result.json"
    if result_path.exists():
        content = result_path.read_bytes()
        await upload_attachment(ticket_id, "task_result.json", content, "application/json")
    logger.info("Execute (LangGraph) finished for %s success=%s", ticket_id, success)
    emit_event("worker.phase", ticket_id, {"phase": "execute", "detail": f"done — {'success' if success else 'failed'}"})
    return {"success": success}


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


def _detect_project_type(test_cwd: Path) -> str | None:
    """Return project type for build/test registry: 'node', 'dotnet', 'python', or None."""
    if not test_cwd or not test_cwd.exists():
        return None
    if (test_cwd / "package.json").exists():
        return "node"
    if list(test_cwd.glob("*.csproj")):
        return "dotnet"
    if (test_cwd / "pyproject.toml").exists() or (test_cwd / "setup.py").exists():
        return "python"
    return None


def _node_build_commands(cwd: Path) -> list[tuple[str, list[str]]]:
    """Return build commands for Node: npm run build only if script exists."""
    commands: list[tuple[str, list[str]]] = []
    pkg_path = cwd / "package.json"
    if pkg_path.exists():
        try:
            pkg = json.loads(pkg_path.read_text())
            scripts = pkg.get("scripts") or {}
            if scripts.get("build"):
                commands.append(("build (node)", ["npm", "run", "build"]))
        except Exception:
            pass
    return commands


def _node_test_commands(cwd: Path) -> list[tuple[str, list[str]]]:
    """Return test commands for Node: prefer test:run then test. If no test script exists, return empty (build-only pass for scaffolding)."""
    commands: list[tuple[str, list[str]]] = []
    pkg_path = cwd / "package.json"
    if pkg_path.exists():
        try:
            pkg = json.loads(pkg_path.read_text())
            scripts = pkg.get("scripts") or {}
            if scripts.get("test:run"):
                commands.append(("test (node)", ["npm", "run", "test:run"]))
            elif scripts.get("test"):
                commands.append(("test (node)", ["npm", "test"]))
            # If no test script: return empty so run_task_tests can treat build-only as pass (e.g. scaffolding)
        except Exception:
            pass
    return commands[:1]  # use first matching


def _is_dotnet_no_tests_failure(output: str) -> bool:
    """True if dotnet test failed only because there are no test projects / no tests (scaffolding)."""
    if not output:
        return False
    lower = output.lower()
    return (
        "no test is available" in lower
        or "no test project" in lower
        or "could not find any test" in lower
        or "no tests to run" in lower
    )


# Registry: (project_type, build_commands_factory, test_commands_factory)
# Each factory takes Path cwd and returns list of (label, cmd_list).
_BUILD_TEST_REGISTRY: list[tuple[str, list[tuple[str, list[str]]], list[tuple[str, list[str]]]]] = [
    ("node", _node_build_commands, lambda cwd: _node_test_commands(cwd)),
    ("dotnet", lambda cwd: [("build (dotnet)", ["dotnet", "build"])], lambda cwd: [("test (dotnet)", ["dotnet", "test", "--no-build"])]),
    ("python", lambda cwd: [], lambda cwd: [("test (python)", ["pytest", "-v", "--tb=short"])]),
]

# Fallback when no project type detected: try these in order (no build).
_FALLBACK_TEST_COMMANDS: list[tuple[str, list[str]]] = [
    ("pytest", ["pytest", "-v", "--tb=short"]),
    ("dotnet test", ["dotnet", "test", "-v", "n"]),
    ("npm test", ["npm", "test"]),
]


def get_build_test_command_hint(workspace_path: str) -> str:
    """Return instructions for the implementer: which build/test commands to run before finishing.
    Uses the same detection as run_task_tests so the implementer runs what the worker will run."""
    path = Path(workspace_path)
    test_cwd = _find_test_cwd(workspace_path)
    if not test_cwd or not test_cwd.exists():
        return ""
    project_type = _detect_project_type(test_cwd)
    if not project_type:
        return ""
    parts: list[str] = []
    for ptype, build_factory, test_factory in _BUILD_TEST_REGISTRY:
        if ptype != project_type:
            continue
        build_cmds = build_factory(test_cwd) if callable(build_factory) else build_factory
        test_cmds = test_factory(test_cwd) if callable(test_factory) else test_factory
        for _, cmd_list in build_cmds:
            parts.append(" ".join(cmd_list))
        for _, cmd_list in test_cmds:
            parts.append(" ".join(cmd_list))
        break
    if not parts:
        return ""
    try:
        rel = test_cwd.resolve().relative_to(path.resolve())
        prefix = f"cd {rel} && " if str(rel) != "." else ""
    except ValueError:
        prefix = ""
    commands_str = " && ".join(parts)
    return (
        f"Before replying with your final summary, you MUST run the project's build and tests and fix any failures. "
        f"Run: {prefix}{commands_str}"
    )


@activity.defn
async def workspace_has_code(workspace_path: str) -> dict:
    """Return whether workspace (or any subdir) has a project (package.json, pyproject.toml, *.csproj)."""
    return {"has_code": _find_test_cwd(workspace_path) is not None}


@activity.defn
async def run_task_tests(ticket_id: str, workspace_path: str) -> dict:
    """Run build (if any) then tests for the detected project type; capture log; persist for reviewer; return success/failure."""
    import subprocess
    path = Path(workspace_path)
    test_cwd = _find_test_cwd(workspace_path) or path
    log_lines: list[str] = []
    success = False
    timeout_sec = 120

    emit_event("worker.phase", ticket_id, {"phase": "build_test", "detail": "running build then tests"})

    project_type = _detect_project_type(test_cwd)
    if project_type and test_cwd.exists():
        # Use registry for this project type
        build_cmds: list[tuple[str, list[str]]] = []
        test_cmds: list[tuple[str, list[str]]] = []
        for ptype, build_factory, test_factory in _BUILD_TEST_REGISTRY:
            if ptype == project_type:
                build_cmds = build_factory(test_cwd) if callable(build_factory) else build_factory
                test_cmds = test_factory(test_cwd) if callable(test_factory) else test_factory
                break
        build_ok = True
        for label, cmd in build_cmds:
            try:
                r = subprocess.run(
                    cmd,
                    cwd=test_cwd,
                    capture_output=True,
                    text=True,
                    timeout=timeout_sec,
                )
                out = (r.stdout or "") + (r.stderr or "")
                log_lines.append(f"=== {label} (cwd={test_cwd}) ===\n{out}")
                if r.returncode != 0:
                    build_ok = False
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                log_lines.append(f"=== {label} (cwd={test_cwd}) ===\nError: {e}")
                build_ok = False
        if not build_ok:
            success = False
        elif not test_cmds:
            # No test script (e.g. scaffolding / first stage): build-only pass
            log_lines.append(f"=== (no test script) (cwd={test_cwd}) ===\nBuild passed; no test script in package.json — treated as pass (scaffolding).")
            success = True
        else:
            for label, cmd in test_cmds:
                try:
                    r = subprocess.run(
                        cmd,
                        cwd=test_cwd,
                        capture_output=True,
                        text=True,
                        timeout=timeout_sec,
                    )
                    out = (r.stdout or "") + (r.stderr or "")
                    log_lines.append(f"=== {label} (cwd={test_cwd}) ===\n{out}")
                    success = r.returncode == 0
                    if not success and project_type == "dotnet" and _is_dotnet_no_tests_failure(out):
                        success = True
                        log_lines.append("(dotnet: no test projects / no tests — treated as pass for scaffolding)")
                    break
                except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                    log_lines.append(f"=== {label} (cwd={test_cwd}) ===\nError: {e}")
                    success = False
    if not log_lines:
        # Fallback: try generic test commands in order
        for label, cmd in _FALLBACK_TEST_COMMANDS:
            if not test_cwd.exists():
                continue
            try:
                r = subprocess.run(
                    cmd,
                    cwd=test_cwd,
                    capture_output=True,
                    text=True,
                    timeout=timeout_sec,
                )
                out = (r.stdout or "") + (r.stderr or "")
                log_lines.append(f"=== {label} (cwd={test_cwd}) ===\n{out}")
                success = r.returncode == 0
                break
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
    if not log_lines:
        log_lines.append("No test runner found (pytest, dotnet, npm).")

    log_content_str = "\n".join(log_lines)
    log_content = log_content_str.encode()
    excerpt_len = 8000
    if len(log_content_str) <= excerpt_len:
        excerpt = log_content_str
    else:
        half = excerpt_len // 2
        excerpt = log_content_str[:half] + "\n\n...(truncated middle)...\n\n" + log_content_str[-half:]

    # Persist for reviewer (last 8000 chars)
    ci_log_path = path / ".dark-factory-ci.log"
    try:
        ci_log_path.write_text(log_content_str[-8000:] if len(log_content_str) > 8000 else log_content_str, encoding="utf-8")
    except Exception as e:
        logger.warning("run_task_tests: could not write .dark-factory-ci.log: %s", e)

    await upload_attachment(ticket_id, "run_tests.log", log_content, "text/plain")
    emit_event(
        "worker.phase",
        ticket_id,
        {"phase": "build_test", "detail": f"done — {'passed' if success else 'failed'}"},
    )
    return {"success": success, "log_excerpt": excerpt}


@activity.defn
async def open_or_update_pr(
    ticket_id: str,
    workspace_path: str,
    branch: str,
    repo: str | None = None,
    existing_pr_number: int = 0,
) -> dict:
    """Push branch, create or update PR (Gitea or GitHub). When existing_pr_number>0, only push and return that PR. PATCH run, transition to Review, upload task_result and log. Review is posted by review_pr activity."""
    emit_event("worker.phase", ticket_id, {"phase": "open_pr", "detail": "pushing branch & creating PR"})
    path = Path(workspace_path)
    repo_slug = repo or _repo_slug_from_path(path)
    pr_url = None
    pr_number = 0
    if repo_slug:
        try:
            _ensure_repo_exists(repo_slug)
        except RuntimeError as e:
            err = str(e)
            await patch_run(ticket_id, last_error=err)
            emit_event("worker.error", ticket_id, {"phase": "open_pr", "message": err})
            raise RuntimeError(f"Open PR (Gitea/repo check): {err}") from e

    body_path = path / "task_result.json"
    tr: dict = {}
    if body_path.exists():
        try:
            tr = json.loads(body_path.read_text())
        except Exception:
            pass
    body = _format_pr_body_from_task_result(tr, ticket_id) if tr else f"Task {ticket_id}"

    ci_log_path = path / ".dark-factory-ci.log"
    if ci_log_path.exists():
        try:
            ci_log_text = ci_log_path.read_text(encoding="utf-8", errors="replace")
            snippet = ci_log_text[-1500:] if len(ci_log_text) > 1500 else ci_log_text
            body = body + "\n\n---\n\n## Build & test (last run)\n\n```\n" + snippet + "\n```"
        except Exception as e:
            logger.debug("open_or_update_pr: could not read .dark-factory-ci.log: %s", e)

    # Descriptive PR title: [ticket_id] Task title (run_guid)
    run_guid = ""
    meta_path = path / ".dark-factory.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            run_guid = (meta.get("run_guid") or "").strip()
        except Exception:
            pass
    if not run_guid and branch.count("-") >= 2:
        # Branch is task/slug-id-guid; last segment is 8-char guid
        last = branch.split("-")[-1]
        if len(last) == 8 and all(c in "0123456789abcdef" for c in last.lower()):
            run_guid = last
    title_snippet = f"Task ({run_guid})" if run_guid else "Task"
    if tr:
        spec = (tr.get("task_spec") or "").strip()
        if spec:
            first_line = spec.split("\n")[0].strip().lstrip("#").strip()
            if first_line:
                title_snippet = f"{first_line[:50].rstrip()} ({run_guid})" if run_guid else first_line[:60]
    pr_title = f"[{ticket_id}] {title_snippet}"

    if GITEA_URL and GITEA_TOKEN and repo_slug:
        import httpx
        import subprocess
        import git
        logger.info("open_or_update_pr: pushing branch %s to Gitea %s", branch, repo_slug)
        try:
            g = git.Repo(workspace_path)
            g.config_writer().set_value("user", "name", "worker").release()
            g.config_writer().set_value("user", "email", "worker@local").release()
            g.git.add(A=True)
            try:
                g.git.commit("-m", f"[{ticket_id}] implementation")
            except Exception:
                pass
            origin_url = None
            for r in list(g.remotes):
                if getattr(r, "name", None) == "origin":
                    origin_url = getattr(r, "url", None) or ""
                    break
            origin_sanitized = _sanitize_url(origin_url or "")
            emit_event(
                "worker.debug",
                ticket_id,
                {
                    "stage": "open_pr_before_push",
                    "origin_url": origin_sanitized,
                    "expected_repo": repo_slug,
                    "branch": branch,
                    "gitea_url": _sanitize_url(GITEA_URL) if GITEA_URL else None,
                },
            )
            logger.info("open_or_update_pr: origin=%s expected_repo=%s branch=%s", origin_sanitized, repo_slug, branch)
            push_stdout = ""
            push_stderr = ""
            for r in list(g.remotes):
                if getattr(r, "name", None) == "origin":
                    try:
                        proc = subprocess.run(
                            ["git", "push", "origin", branch],
                            cwd=workspace_path,
                            capture_output=True,
                            text=True,
                            timeout=60,
                        )
                        push_stdout = (proc.stdout or "").strip()[:500]
                        push_stderr = (proc.stderr or "").strip()[:500]
                        if proc.returncode != 0:
                            raise RuntimeError(f"git push failed: {push_stderr or push_stdout or 'no output'}")
                    except subprocess.TimeoutExpired as e:
                        raise RuntimeError(f"git push timed out: {e}") from e
                    logger.info("Push succeeded for branch %s stdout=%r stderr=%r", branch, push_stdout, push_stderr)
                    emit_event(
                        "worker.pr",
                        ticket_id,
                        {"action": "pushed", "branch": branch, "push_stdout": push_stdout, "push_stderr": push_stderr},
                    )
                    break
        except Exception as e:
            logger.error("Push failed: %s", e)
            await patch_run(ticket_id, last_error=f"Push failed: {e}")
            emit_event("worker.error", ticket_id, {"phase": "open_pr", "message": f"Push failed: {e}"})
            return {"pr_url": None, "pr_number": 0}
        owner, name = repo_slug.split("/", 1)
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        # Verify branch exists on Gitea before creating PR (404 on POST /pulls often means head branch missing)
        if existing_pr_number == 0:
            try:
                br = httpx.get(
                    f"{base_url}/branches/{branch}",
                    headers={"Authorization": f"token {GITEA_TOKEN}"},
                    timeout=10,
                )
                if br.status_code == 404:
                    existing_branches = []
                    try:
                        list_br = httpx.get(
                            f"{base_url}/branches",
                            headers={"Authorization": f"token {GITEA_TOKEN}"},
                            timeout=10,
                        )
                        if list_br.status_code == 200 and isinstance(list_br.json(), list):
                            existing_branches = [b.get("name", "") for b in list_br.json()[:20] if isinstance(b, dict)]
                    except Exception:
                        pass
                    err = (
                        f"Branch '{branch}' not found on Gitea after push. "
                        "Push may have failed, or origin remote may not point to this repo. "
                        f"Check that origin URL is for {repo_slug} and GITEA_TOKEN has push permission."
                    )
                    await patch_run(ticket_id, last_error=err)
                    emit_event(
                        "worker.error",
                        ticket_id,
                        {
                            "phase": "open_pr",
                            "message": err,
                            "expected_branch": branch,
                            "expected_repo": repo_slug,
                            "existing_branches_on_gitea": existing_branches,
                        },
                    )
                    return {"pr_url": None, "pr_number": 0}
                if not br.is_success:
                    err = f"Gitea branches check failed: {br.status_code} {br.text[:200]}"
                    await patch_run(ticket_id, last_error=err)
                    emit_event("worker.error", ticket_id, {"phase": "open_pr", "message": err})
                    return {"pr_url": None, "pr_number": 0}
            except Exception as e:
                if isinstance(e, RuntimeError):
                    raise
                logger.warning("Could not verify branch on Gitea: %s", e)
        if existing_pr_number > 0:
            try:
                r = httpx.get(f"{base_url}/pulls/{existing_pr_number}", headers={"Authorization": f"token {GITEA_TOKEN}"}, timeout=10)
                r.raise_for_status()
                pr_j = r.json()
                pr_number = existing_pr_number
                pr_url = pr_j.get("html_url") or f"{GITEA_URL}/{owner}/{name}/pulls/{pr_number}"
                emit_event("worker.pr", ticket_id, {"action": "updated", "pr_number": pr_number, "url": pr_url})
            except Exception as e:
                await patch_run(ticket_id, last_error=str(e))
                return {"pr_url": None, "pr_number": 0}
        else:
            try:
                r = httpx.get(f"{base_url}", headers={"Authorization": f"token {GITEA_TOKEN}"}, timeout=10)
                r.raise_for_status()
                default_branch = r.json().get("default_branch", "main")
            except Exception as e:
                await patch_run(
                    ticket_id,
                    last_error=f"GET repo failed (repo may not exist or token has no access): {e}",
                )
                return {"pr_url": None, "pr_number": 0}
            try:
                logger.info("Creating Gitea PR: head=%s base=%s title=%s", branch, default_branch, pr_title)
                pr_r = httpx.post(
                    f"{base_url}/pulls",
                    headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
                    json={"title": pr_title, "body": _truncate_for_comment(body), "head": branch, "base": default_branch},
                    timeout=15,
                )
                if pr_r.status_code >= 400:
                    logger.error("Gitea PR creation failed %d: %s", pr_r.status_code, pr_r.text[:500])
                    body_preview = (pr_r.text or "")[:400]
                    if pr_r.status_code == 404:
                        err_msg = (
                            f"Create PR failed (404). Head branch '{branch}' may not exist on Gitea. "
                            "Ensure origin remote points to this repo and push succeeded. "
                            f"Gitea response: {body_preview}"
                        )
                    else:
                        err_msg = f"Gitea PR creation failed {pr_r.status_code}: {body_preview}"
                    await patch_run(ticket_id, last_error=err_msg)
                    emit_event("worker.error", ticket_id, {"phase": "open_pr", "message": err_msg})
                    return {"pr_url": None, "pr_number": 0}
                pr_r.raise_for_status()
                pr_j = pr_r.json()
                pr_number = pr_j.get("number") or pr_j.get("index") or 0
                pr_url = pr_j.get("html_url") or f"{GITEA_URL}/{owner}/{name}/pulls/{pr_number}"
                emit_event("worker.pr", ticket_id, {"action": "created", "pr_number": pr_number, "url": pr_url})
            except Exception as e:
                err_msg = str(e)
                if "404" in err_msg and "/pulls" in err_msg:
                    err_msg = (
                        f"Create PR failed (404). Head branch '{branch}' may not exist on Gitea. "
                        "Push may have failed or origin may point elsewhere. "
                        f"Raw: {e}"
                    )
                await patch_run(ticket_id, last_error=err_msg)
                emit_event("worker.error", ticket_id, {"phase": "open_pr", "message": err_msg})
                return {"pr_url": None, "pr_number": 0}
    elif GITHUB_TOKEN and repo_slug:
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
        if existing_pr_number > 0:
            try:
                from github import Github
                gh = Github(GITHUB_TOKEN)
                pr = gh.get_repo(repo_slug).get_pull(existing_pr_number)
                pr_url = pr.html_url
                pr_number = existing_pr_number
                emit_event("worker.pr", ticket_id, {"action": "updated", "pr_number": pr_number, "url": pr_url})
            except Exception as e:
                await patch_run(ticket_id, last_error=str(e))
                return {"pr_url": None, "pr_number": 0}
        else:
            try:
                from github import Github
                gh = Github(GITHUB_TOKEN)
                repo_obj = gh.get_repo(repo_slug)
                pr = repo_obj.create_pull(title=pr_title, body=_truncate_for_comment(body), head=branch, base=repo_obj.default_branch)
                pr_url = pr.html_url
                pr_number = pr.number
            except Exception as e:
                await patch_run(ticket_id, last_error=str(e))
                return {"pr_url": None, "pr_number": 0}
    await patch_run(ticket_id, pr_number=pr_number if pr_number else None, pr_url=pr_url)
    await transition(ticket_id, "Review", note="PR opened", by="worker")
    if (path / "task_result.json").exists():
        await upload_attachment(ticket_id, "task_result.json", (path / "task_result.json").read_bytes(), "application/json")
    log_path = path / "run_tests.log"
    if log_path.exists():
        await upload_attachment(ticket_id, "run_tests.log", log_path.read_bytes(), "text/plain")
    return {"pr_url": pr_url, "pr_number": pr_number}


def _post_pr_comment(repo_slug: str, pr_number: int, body: str, _review_round: int = 1) -> None:
    """Post a comment on the PR (issue comment API) so the review appears in the PR thread."""
    owner, name = repo_slug.strip().split("/", 1)
    comment_body = _truncate_for_comment(body)
    if GITEA_URL and GITEA_TOKEN:
        import httpx
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        # In Gitea, a PR is an issue; use issues/{index}/comments
        r = httpx.post(
            f"{base_url}/issues/{pr_number}/comments",
            headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
            json={"body": comment_body},
            timeout=10,
        )
        if r.status_code >= 400:
            logger.warning("review_pr: failed to post PR comment: %d %s", r.status_code, r.text[:200])
    elif GITHUB_TOKEN:
        from github import Github
        gh = Github(GITHUB_TOKEN)
        pr = gh.get_repo(repo_slug.strip()).get_pull(pr_number)
        pr.create_issue_comment(comment_body)


@activity.defn
async def post_pr_comment(ticket_id: str, pr_number: int, repo: str, body: str) -> None:
    """Post a comment on the PR so the back-and-forth is visible (e.g. 'Implementer is addressing feedback...')."""
    _post_pr_comment(repo, pr_number, body)


@activity.defn
async def review_pr(
    ticket_id: str,
    pr_number: int,
    repo: str,
    workspace_path: str,
    skip_human_approval: bool = True,
    review_round: int = 1,
) -> dict:
    """
    Fetch PR (body + diff), run Reviewer LLM, post review to PR, merge if pass.
    Returns dict: verdict (pass/fail/risky), body (review summary).
    When verdict is risky and not skip_human_approval: also needs_approval=True, decision_id=<uuid>.
    """
    import uuid
    import httpx
    path = Path(workspace_path)
    task_result_path = path / "task_result.json"
    task_spec = ""
    checklist = []
    implementer_summary = ""
    if task_result_path.exists():
        try:
            data = json.loads(task_result_path.read_text())
            task_spec = (data.get("task_spec") or "").strip()
            checklist = data.get("checklist") or []
            if not isinstance(checklist, list):
                checklist = [str(checklist)]
            implementer_summary = (data.get("implementer_summary") or "").strip()
        except Exception as e:
            logger.warning("review_pr: failed to read task_result.json: %s", e)
    if not task_spec:
        task_spec = f"Task {ticket_id}"

    pr_body = ""
    pr_diff = ""
    owner, name = repo.strip().split("/", 1)
    if GITEA_URL and GITEA_TOKEN:
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        try:
            r = httpx.get(
                f"{base_url}/pulls/{pr_number}",
                headers={"Authorization": f"token {GITEA_TOKEN}"},
                timeout=15,
            )
            r.raise_for_status()
            pr_body = (r.json().get("body") or "").strip()
            diff_r = httpx.get(
                f"{base_url}/pulls/{pr_number}.diff",
                headers={"Authorization": f"token {GITEA_TOKEN}"},
                timeout=30,
            )
            if diff_r.status_code == 200:
                pr_diff = (diff_r.text or "").strip()
        except Exception as e:
            logger.warning("review_pr: fetch PR failed: %s", e)
    elif GITHUB_TOKEN:
        try:
            from github import Github
            gh = Github(GITHUB_TOKEN)
            repo_obj = gh.get_repo(repo.strip())
            pr = repo_obj.get_pull(pr_number)
            pr_body = (pr.body or "").strip()
            try:
                pr_diff = (pr.diff() or "").strip()
            except Exception:
                pr_diff = ""
            if not pr_diff and hasattr(pr, "get_files"):
                files = pr.get_files() or []
                pr_diff = "\n".join(f"{f.filename}\n{f.patch or ''}" for f in files[:30])
        except Exception as e:
            logger.warning("review_pr: fetch PR (GitHub) failed: %s", e)

    # Get full list of changed files from git so reviewer can verify even when task_result files_changed is incomplete
    all_changed_files: list[str] = []
    try:
        import subprocess
        res = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if res.returncode == 0 and res.stdout:
            all_changed_files = [line.strip() for line in res.stdout.strip().splitlines() if line.strip()]
        if not all_changed_files:
            # Try against merge base with default branch (e.g. main)
            for base in ["origin/main", "origin/master", "main", "master"]:
                res = subprocess.run(
                    ["git", "diff", "--name-only", f"{base}...HEAD"],
                    cwd=path,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if res.returncode == 0 and res.stdout:
                    all_changed_files = [line.strip() for line in res.stdout.strip().splitlines() if line.strip()]
                    break
    except Exception as e:
        logger.debug("review_pr: git diff --name-only failed: %s", e)

    build_and_test_output = ""
    ci_log_path = path / ".dark-factory-ci.log"
    if ci_log_path.exists():
        try:
            full_log = ci_log_path.read_text(encoding="utf-8", errors="replace")
            build_and_test_output = full_log[-3000:] if len(full_log) > 3000 else full_log
        except Exception as e:
            logger.debug("review_pr: could not read .dark-factory-ci.log: %s", e)

    from langgraph_runner import review_pr_content
    emit_event("worker.phase", ticket_id, {"phase": "reviewer", "detail": "waiting for LLM response"})
    verdict, body, remaining_issues = review_pr_content(
        task_spec=task_spec,
        checklist=checklist,
        pr_body=pr_body,
        pr_diff=pr_diff,
        implementer_summary=implementer_summary,
        ticket_id=ticket_id,
        all_changed_files=all_changed_files,
        build_and_test_output=build_and_test_output,
    )
    emit_event("worker.phase", ticket_id, {"phase": "reviewer", "detail": "done"})
    verdict = (verdict or "pass").strip().lower()

    event = "APPROVE" if verdict == "pass" else ("REQUEST_CHANGES" if verdict == "fail" else "COMMENT")
    review_body = (body or "Task completed.").strip()
    # Post as formal review (sets approve / request changes state)
    if GITEA_URL and GITEA_TOKEN:
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        httpx.post(
            f"{base_url}/pulls/{pr_number}/reviews",
            headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
            json={"event": event, "body": _truncate_for_comment(review_body)},
            timeout=10,
        )
        # Post same as PR comment so the full back-and-forth is visible in the PR thread
        comment_text = f"**Reviewer** (round {review_round}): Verdict: **{verdict}**\n\n{review_body}"
        _post_pr_comment(repo, pr_number, comment_text, review_round)
        if verdict == "pass":
            try:
                merge_r = httpx.post(
                    f"{base_url}/pulls/{pr_number}/merge",
                    headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
                    json={"Do": "merge"},
                    timeout=15,
                )
                merge_r.raise_for_status()
                logger.info("review_pr: Gitea PR #%d merged", pr_number)
                emit_event("worker.pr", ticket_id, {"action": "merged", "pr_number": pr_number, "merged": True})
            except Exception as merge_err:
                logger.warning("review_pr: Gitea merge failed: %s", merge_err)
    elif GITHUB_TOKEN:
        from github import Github
        gh = Github(GITHUB_TOKEN)
        repo_obj = gh.get_repo(repo.strip())
        pr = repo_obj.get_pull(pr_number)
        pr.create_review(event=event, body=_truncate_for_comment(review_body))
        comment_text = f"**Reviewer** (round {review_round}): Verdict: **{verdict}**\n\n{review_body}"
        _post_pr_comment(repo, pr_number, comment_text, review_round)
        if verdict == "pass":
            try:
                pr.merge(merge_method=GITHUB_MERGE_METHOD)
                logger.info("review_pr: GitHub PR #%d merged", pr_number)
                emit_event("worker.pr", ticket_id, {"action": "merged", "pr_number": pr_number, "merged": True})
            except Exception as merge_err:
                logger.warning("review_pr: GitHub merge failed: %s", merge_err)

    result = {"verdict": verdict, "body": body or "", "remaining_issues": remaining_issues or ""}
    if verdict == "risky" and not skip_human_approval:
        decision_id = str(uuid.uuid4())
        result["needs_approval"] = True
        result["decision_id"] = decision_id
        await patch_run(ticket_id, phase="AwaitingApproval", pending_approval_decision_id=decision_id)
        await transition(ticket_id, "Blocked", note="Awaiting approval", by="worker")
    return result


@activity.defn
async def merge_pr(ticket_id: str, pr_number: int, repo: str) -> None:
    """Merge the PR (Gitea or GitHub). Used after human approves a risky review."""
    owner, name = repo.strip().split("/", 1)
    if GITEA_URL and GITEA_TOKEN:
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        import httpx
        r = httpx.post(
            f"{base_url}/pulls/{pr_number}/merge",
            headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
            json={"Do": "merge"},
            timeout=15,
        )
        r.raise_for_status()
        logger.info("merge_pr: Gitea PR #%d merged", pr_number)
        emit_event("worker.pr", ticket_id, {"action": "merged", "pr_number": pr_number, "merged": True})
    elif GITHUB_TOKEN:
        from github import Github
        gh = Github(GITHUB_TOKEN)
        pr = gh.get_repo(repo.strip()).get_pull(pr_number)
        pr.merge(merge_method=GITHUB_MERGE_METHOD)
        logger.info("merge_pr: GitHub PR #%d merged", pr_number)
        emit_event("worker.pr", ticket_id, {"action": "merged", "pr_number": pr_number, "merged": True})
    else:
        raise RuntimeError("No GITEA or GITHUB token configured for merge_pr")


@activity.defn
async def wait_for_review_and_ci(ticket_id: str, pr_number: int, repo: str | None = None) -> str:
    """Poll PR state (Gitea or GitHub). Returns 'merged' | 'changes_requested' | 'rejected'."""
    if not repo or pr_number <= 0:
        return "rejected"
    import time
    if GITEA_URL and GITEA_TOKEN and repo:
        import httpx
        owner, name = repo.strip().split("/", 1)
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        for attempt in range(30):
            r = httpx.get(f"{base_url}/pulls/{pr_number}", headers={"Authorization": f"token {GITEA_TOKEN}"}, timeout=10)
            if r.status_code != 200:
                logger.warning("wait_for_review: PR %d fetch failed %d", pr_number, r.status_code)
                time.sleep(10)
                continue
            pr_j = r.json()
            if pr_j.get("merged"):
                await patch_run(ticket_id, last_ci_state="success")
                logger.info("wait_for_review: PR %d already merged", pr_number)
                return "merged"
            if pr_j.get("state") == "closed":
                await patch_run(ticket_id, last_ci_state="failure")
                return "rejected"
            rev = httpx.get(f"{base_url}/pulls/{pr_number}/reviews", headers={"Authorization": f"token {GITEA_TOKEN}"}, timeout=10)
            has_approval = False
            if rev.status_code == 200:
                for rev_item in rev.json() or []:
                    s = (rev_item.get("state") or "").upper()
                    if s == "REQUEST_CHANGES":
                        return "changes_requested"
                    if s == "APPROVED" or s == "APPROVE":
                        has_approval = True
            if has_approval and not pr_j.get("merged"):
                logger.info("wait_for_review: PR %d has approval, attempting merge", pr_number)
                try:
                    merge_r = httpx.post(
                        f"{base_url}/pulls/{pr_number}/merge",
                        headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
                        json={"Do": "merge"},
                        timeout=15,
                    )
                    if merge_r.status_code < 300:
                        logger.info("wait_for_review: merge succeeded for PR %d", pr_number)
                        await patch_run(ticket_id, last_ci_state="success")
                        return "merged"
                    else:
                        logger.warning("wait_for_review: merge attempt failed %d: %s", merge_r.status_code, merge_r.text[:200])
                except Exception as e:
                    logger.warning("wait_for_review: merge attempt error: %s", e)
            time.sleep(10)
        logger.warning("wait_for_review: timed out after %d attempts", 30)
        return "rejected"
    if GITHUB_TOKEN:
        from github import Github
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
    return "merged"


@activity.defn
async def patch_run_workflow_id(ticket_id: str, workflow_id: str) -> None:
    """PATCH run with workflow_id so API can signal Temporal."""
    await patch_run(ticket_id, workflow_id=workflow_id)


@activity.defn
async def transition_ticket(ticket_id: str, to: str, note: str | None = None, by: str = "worker") -> None:
    """Transition ticket status."""
    await transition(ticket_id, to, note=note, by=by)


@activity.defn
async def close_task(
    ticket_id: str, owner: str, transition_to: str = "Done", note: str | None = None
) -> None:
    """Transition ticket first, then release run. Order ensures that if we crash or retry after transition,
    the ticket is already Ready/Done; retrying release is safe (idempotent on API for expired lock)."""
    emit_event("worker.phase", ticket_id, {"phase": "close_task", "detail": f"transitioning to {transition_to} then releasing"})
    transition_note = note
    if transition_note is None:
        transition_note = "Closed by worker" if transition_to == "Done" else "Released (no PR completed)"
    await transition(ticket_id, transition_to, note=transition_note, by=owner)
    if transition_to == "Done":
        await post_update(ticket_id, "Task closed.", author=owner)
    else:
        await post_update(ticket_id, "Run released; ticket re-queued as Ready.", author=owner)
    result = await release(ticket_id, owner)
    if not result.get("released"):
        err = (result.get("error") or "").lower()
        if "lock" in err or "conflict" in err:
            # Lock already cleared (e.g. previous attempt released then crashed); ticket already transitioned
            return
        raise RuntimeError(result.get("error", "release failed"))


@activity.defn
async def cleanup_workspace(workspace_path: str) -> None:
    """Remove or reset the workspace after a task finishes."""
    ws = Path(workspace_path)
    if not ws.exists():
        return

    if WORKSPACE_PATH and str(ws) == str(Path(WORKSPACE_PATH).resolve()):
        # Shared directory (Docker mode) -- reset git state, keep the folder
        import subprocess
        try:
            subprocess.run(["git", "clean", "-fdx"], cwd=str(ws), capture_output=True, timeout=30, check=False)
            subprocess.run(["git", "checkout", "main"], cwd=str(ws), capture_output=True, timeout=10, check=False)
            logger.info("Cleaned workspace (WORKSPACE_PATH mode): %s", ws)
        except Exception as e:
            logger.warning("Workspace cleanup (git clean) failed: %s", e)
    else:
        # Per-ticket clone folder -- delete entirely
        try:
            shutil.rmtree(ws)
            logger.info("Removed workspace folder: %s", ws)
        except Exception as e:
            logger.warning("Workspace cleanup (rmtree) failed: %s", e)
