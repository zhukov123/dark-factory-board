"""Temporal activities for DarkFactoryRun."""
import json
import logging
import re
from pathlib import Path

from temporalio import activity

logger = logging.getLogger(__name__)

from config import REPO_CLONE_ROOT, GITHUB_TOKEN, GITEA_URL, GITEA_TOKEN, WORKSPACE_REPO, WORKSPACE_PATH, GITHUB_MERGE_METHOD
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


def _ensure_repo_exists(repo_slug: str) -> None:
    """Ensure the repo exists on the host; create if 404 (GitHub or Gitea)."""
    if not repo_slug or "/" not in repo_slug:
        return
    parts = repo_slug.split("/", 1)
    owner, name = parts[0], parts[1]
    if GITEA_URL and GITEA_TOKEN:
        import httpx
        url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        try:
            r = httpx.get(url, headers={"Authorization": f"token {GITEA_TOKEN}"}, timeout=10)
            if r.status_code == 404:
                create_url = f"{GITEA_URL}/api/v1/user/repos"
                r2 = httpx.post(
                    create_url,
                    headers={"Authorization": f"token {GITEA_TOKEN}"},
                    json={"name": name, "private": True},
                    timeout=15,
                )
                r2.raise_for_status()
        except Exception as e:
            logger.warning("Gitea ensure repo failed: %s", e)
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


@activity.defn
async def prepare_workspace(ticket_id: str, task_spec: str, repo: str | None = None) -> dict:
    """Clone repo (or use WORKSPACE_PATH), create branch task/{ticket_id_slug}-{short_id}, write metadata, PATCH run.
    Returns workspace_path, branch, and repo (for PR)."""
    logger.info("Prepare workspace started for %s", ticket_id)
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
    if effective:
        logger.info("Ensuring repo exists: %s", effective)
        _ensure_repo_exists(effective)
    repo_url = _repo_url(effective)
    logger.info("repo_url=%s workspace_path=%s", repo_url, workspace_path)
    if repo_url:
        try:
            import git
            if workspace_path.exists():
                logger.info("Workspace already exists, fetching")
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
                logger.info("Cloning %s -> %s", repo_url, workspace_path)
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

    logger.info("Prepare workspace finished for %s -> %s", ticket_id, workspace_path)
    return {"workspace_path": str(workspace_path), "branch": branch, "repo": effective}


@activity.defn
async def execute_task_with_lang_graph(
    ticket_id: str, task_spec: str, workspace_path: str, branch: str,
    resume_decision_id: str | None = None,
) -> dict:
    """Run LangGraph; on interrupt return needs_approval + decision_id. Write task_result.json and upload."""
    logger.info("Execute (LangGraph) started for %s", ticket_id)
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
    logger.info("Execute (LangGraph) finished for %s success=%s", ticket_id, success)
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


def _post_review_and_merge_github(pr, body: str) -> None:
    """Post reviewer-persona review and merge when pass (GitHub)."""
    try:
        task_result = json.loads(body) if body else {}
    except Exception:
        task_result = {}
    review_summary = (task_result.get("review_summary") or "").strip() or "Task completed."
    verdict = (task_result.get("reviewer_verdict") or "pass").strip().lower()
    event = "APPROVE" if verdict == "pass" else ("REQUEST_CHANGES" if verdict == "fail" else "COMMENT")
    pr.create_review(event=event, body=review_summary[:4000])
    if verdict == "pass":
        try:
            pr.merge(merge_method=GITHUB_MERGE_METHOD)
        except Exception as merge_err:
            logger.warning("PR merge failed (branch protection?): %s", merge_err)


@activity.defn
async def open_or_update_pr(ticket_id: str, workspace_path: str, branch: str, repo: str | None = None) -> dict:
    """Push branch, create PR (Gitea or GitHub), post reviewer-persona review, merge when pass, PATCH run (pr_number, pr_url), transition to Review, upload task_result and log."""
    path = Path(workspace_path)
    repo_slug = repo or _repo_slug_from_path(path)
    pr_url = None
    pr_number = 0
    if repo_slug:
        _ensure_repo_exists(repo_slug)

    body_path = path / "task_result.json"
    body = body_path.read_text() if body_path.exists() else f"Task {ticket_id}"

    if GITEA_URL and GITEA_TOKEN and repo_slug:
        import httpx
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
            for r in list(g.remotes):
                if getattr(r, "name", None) == "origin":
                    r.push(branch)
                    logger.info("Push succeeded for branch %s", branch)
                    break
        except Exception as e:
            logger.error("Push failed: %s", e)
            await patch_run(ticket_id, last_error=f"Push failed: {e}")
            return {"pr_url": None, "pr_number": 0}
        owner, name = repo_slug.split("/", 1)
        base_url = f"{GITEA_URL}/api/v1/repos/{owner}/{name}"
        try:
            r = httpx.get(f"{base_url}", headers={"Authorization": f"token {GITEA_TOKEN}"}, timeout=10)
            r.raise_for_status()
            default_branch = r.json().get("default_branch", "main")
        except Exception as e:
            await patch_run(ticket_id, last_error=str(e))
            return {"pr_url": None, "pr_number": 0}
        try:
            logger.info("Creating Gitea PR: head=%s base=%s", branch, default_branch)
            pr_r = httpx.post(
                f"{base_url}/pulls",
                headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
                json={"title": f"[{ticket_id}] Task", "body": body[:5000], "head": branch, "base": default_branch},
                timeout=15,
            )
            if pr_r.status_code >= 400:
                logger.error("Gitea PR creation failed %d: %s", pr_r.status_code, pr_r.text[:500])
            pr_r.raise_for_status()
            pr_j = pr_r.json()
            pr_number = pr_j.get("number") or pr_j.get("index") or 0
            pr_url = pr_j.get("html_url") or f"{GITEA_URL}/{owner}/{name}/pulls/{pr_number}"
            # Post review
            try:
                task_result = json.loads(body) if body else {}
            except Exception:
                task_result = {}
            review_summary = (task_result.get("review_summary") or "").strip() or "Task completed."
            verdict = (task_result.get("reviewer_verdict") or "pass").strip().lower()
            event = "APPROVE" if verdict == "pass" else ("REQUEST_CHANGES" if verdict == "fail" else "COMMENT")
            httpx.post(
                f"{base_url}/pulls/{pr_number}/reviews",
                headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
                json={"event": event, "body": review_summary[:4000]},
                timeout=10,
            )
            if verdict == "pass":
                try:
                    merge_r = httpx.post(
                        f"{base_url}/pulls/{pr_number}/merge",
                        headers={"Authorization": f"token {GITEA_TOKEN}", "Content-Type": "application/json"},
                        json={"Do": "merge"},
                        timeout=15,
                    )
                    merge_r.raise_for_status()
                    logger.info("Gitea PR #%d merged successfully", pr_number)
                except Exception as merge_err:
                    logger.warning("Gitea PR merge failed: %s", merge_err)
        except Exception as e:
            await patch_run(ticket_id, last_error=str(e))
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
        try:
            from github import Github
            gh = Github(GITHUB_TOKEN)
            repo_obj = gh.get_repo(repo_slug)
            pr = repo_obj.create_pull(title=f"[{ticket_id}] Task", body=body[:5000], head=branch, base=repo_obj.default_branch)
            pr_url = pr.html_url
            pr_number = pr.number
            _post_review_and_merge_github(pr, body)
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


@activity.defn
async def wait_for_review_and_ci(ticket_id: str, pr_number: int, repo: str | None = None) -> str:
    """Poll PR state (Gitea or GitHub). Returns 'merged' | 'changes_requested' | 'rejected'."""
    if not repo or pr_number <= 0:
        return "merged"
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
async def close_task(ticket_id: str, owner: str) -> None:
    """POST /runs/release, transition ticket to Done, post update."""
    result = await release(ticket_id, owner)
    if not result.get("released"):
        raise RuntimeError(result.get("error", "release failed"))
    await transition(ticket_id, "Done", note="Closed by worker", by=owner)
    await post_update(ticket_id, "Task closed.", author=owner)
