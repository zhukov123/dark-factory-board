"""HTTP client for the TaskBoard API (snake_case JSON)."""
import logging
import threading
import httpx

from config import TASKBOARD_URL, TASKBOARD_TOKEN

_emit_log = logging.getLogger("emit_event")


def _headers():
    return {
        "Authorization": f"Bearer {TASKBOARD_TOKEN}",
        "Content-Type": "application/json",
    }


async def get_ticket(ticket_id: str) -> dict | None:
    """GET /tickets/{id}. Returns ticket or None if 404."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{TASKBOARD_URL}/tickets/{ticket_id}", headers=_headers())
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()


async def get_pick_next(repo: str | None = None, owner: str | None = None) -> dict:
    """GET /pick-next?repo=... Returns { ticket_id?, task_spec?, reason? }."""
    async with httpx.AsyncClient() as client:
        params = {}
        if repo:
            params["repo"] = repo
        if owner:
            params["owner"] = owner
        r = await client.get(f"{TASKBOARD_URL}/pick-next", params=params, headers=_headers())
        r.raise_for_status()
        return r.json()


async def claim(ticket_id: str, owner: str, ttl_seconds: int) -> dict:
    """POST /runs/claim. Returns { claimed: bool, run?: {...}, error?: str }."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{TASKBOARD_URL}/runs/claim",
            json={"ticket_id": ticket_id, "owner": owner, "ttl_seconds": ttl_seconds},
            headers=_headers(),
        )
        data = r.json() if r.content else {}
        if r.status_code == 404:
            return {"claimed": False, "error": data.get("error", "not found")}
        if r.status_code == 409:
            return {"claimed": False, "error": data.get("error", "conflict")}
        r.raise_for_status()
        return data


async def release(ticket_id: str, owner: str) -> dict:
    """POST /runs/release. Returns { released: bool } or error."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{TASKBOARD_URL}/runs/release",
            json={"ticket_id": ticket_id, "owner": owner},
            headers=_headers(),
        )
        if r.status_code == 404:
            return {"released": False, "error": "not found"}
        if r.status_code == 409:
            data = r.json() if r.content else {}
            return {"released": False, "error": data.get("error", "conflict")}
        r.raise_for_status()
        return r.json() if r.content else {"released": True}


async def patch_run(
    ticket_id: str,
    phase: str | None = None,
    branch: str | None = None,
    pr_number: int | None = None,
    pr_url: str | None = None,
    last_ci_state: str | None = None,
    last_summary: str | None = None,
    last_error: str | None = None,
    workflow_id: str | None = None,
    pending_approval_decision_id: str | None = None,
) -> dict:
    """PATCH /runs/{ticketId}. Only send provided fields."""
    payload = {}
    if phase is not None:
        payload["phase"] = phase
    if branch is not None:
        payload["branch"] = branch
    if pr_number is not None:
        payload["pr_number"] = pr_number
    if pr_url is not None:
        payload["pr_url"] = pr_url
    if last_ci_state is not None:
        payload["last_ci_state"] = last_ci_state
    if last_summary is not None:
        payload["last_summary"] = last_summary
    if last_error is not None:
        payload["last_error"] = last_error
    if workflow_id is not None:
        payload["workflow_id"] = workflow_id
    if pending_approval_decision_id is not None:
        payload["pending_approval_decision_id"] = pending_approval_decision_id
    if not payload:
        return {}
    async with httpx.AsyncClient() as client:
        r = await client.patch(
            f"{TASKBOARD_URL}/runs/{ticket_id}",
            json=payload,
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json() if r.content else {}


async def transition(ticket_id: str, to: str, note: str | None = None, by: str = "worker", force: bool = False) -> dict:
    """POST /tickets/{id}/transition."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{TASKBOARD_URL}/tickets/{ticket_id}/transition",
            json={"to": to, "note": note or "", "by": by, "force": force},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json() if r.content else {}


async def post_update(ticket_id: str, message: str, author: str | None = None) -> dict:
    """POST /tickets/{id}/updates."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{TASKBOARD_URL}/tickets/{ticket_id}/updates",
            json={"message": message, "author": author or "worker"},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json() if r.content else {}


def _trunc(s: str, n: int = 200) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _trunc_long(s: str, n: int = 8000) -> str:
    """Allow longer payloads (e.g. verdict summary, errors) so the full message is stored and visible in the UI."""
    return s if len(s) <= n else s[:n] + "…"


def emit_event(event_type: str, ticket_id: str | None = None, payload: dict | None = None) -> None:
    """Fire-and-forget: POST /events in a daemon thread so it never blocks the caller.
    Safe to call from both sync and async code."""
    body = {"type": event_type, "ticket_id": ticket_id, "payload": payload or {}}

    def _send():
        try:
            httpx.post(f"{TASKBOARD_URL}/events", json=body, headers=_headers(), timeout=5)
        except Exception as exc:
            _emit_log.debug("emit_event %s failed: %s", event_type, exc)

    threading.Thread(target=_send, daemon=True).start()


async def post_event(event_type: str, ticket_id: str | None = None, payload: dict | None = None) -> dict:
    """POST /events."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{TASKBOARD_URL}/events",
            json={"type": event_type, "ticket_id": ticket_id, "payload": payload or {}},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json() if r.content else {}


async def upload_attachment(ticket_id: str, name: str, content: bytes, content_type: str | None = None) -> dict:
    """POST /tickets/{id}/attachments (JSON body with base64 content)."""
    import base64
    async with httpx.AsyncClient() as client:
        body = {"name": name, "content": base64.b64encode(content).decode("ascii")}
        if content_type:
            body["content_type"] = content_type
        r = await client.post(
            f"{TASKBOARD_URL}/tickets/{ticket_id}/attachments",
            json=body,
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json() if r.content else {}


async def list_attachments(ticket_id: str) -> list[dict]:
    """GET /tickets/{id}/attachments. Returns list of { id, name, size, created_at }."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{TASKBOARD_URL}/tickets/{ticket_id}/attachments", headers=_headers())
        r.raise_for_status()
        data = r.json()
        return data.get("items", [])


async def get_attachment(ticket_id: str, attachment_id: int) -> bytes | None:
    """GET /tickets/{id}/attachments/{attachmentId}. Returns bytes or None."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{TASKBOARD_URL}/tickets/{ticket_id}/attachments/{attachment_id}",
            headers=_headers(),
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content
