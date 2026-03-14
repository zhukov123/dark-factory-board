# Deploy TaskBoard with Docker

Build the app once (on your machine or in CI), send the image to the server, and run it. **No code or builds on the server** — only Docker and the image.

## Run everything (API + Web UI + Temporal + Worker)

One stack with TaskBoard, Temporal, Temporal Web UI, and the coding agent:

```bash
# Optional: set LLM in .env (OPENROUTER_API_KEY or LMSTUDIO_BASE_URL)
docker compose up -d
```

- **TaskBoard (API + Web UI):** http://localhost:5173  
- **Temporal Web UI:** http://localhost:8080  
- **Worker (agent):** Runs in its own container. The agent executes tasks (read_file, write_file, run_command) inside that container; the workspace is the mounted volume `worker-workspace` at `/workspace`. So all code the agent writes and commands it runs (e.g. `npm install`, `dotnet build`) happen **inside the worker container**, which has Python, Node, and .NET installed. This is the appropriate place for the agent: it has a full execution environment and an isolated workspace.

To give the agent an LLM, set in `.env` or when running:

- `OPENROUTER_API_KEY=sk-...` (and optionally `OPENROUTER_MODEL=...`), or  
- `LMSTUDIO_BASE_URL=http://host.docker.internal:1234/v1` if the LLM runs on the host.

---

## 1. Build the image (on your machine)

From the repo root:

```bash
docker build -t taskboard:latest .
```

**Deploying to a Linux x86 server from a Mac (Apple Silicon)?** Build for amd64 so the container runs natively on the server:

```bash
docker build --platform linux/amd64 -t taskboard:latest .
```

Build happens locally (Node + .NET); the image contains the published API and UI.

## 2. Send the image to the server

**Option A — Save to tar and copy**

On your machine:

```bash
docker save taskboard:latest | gzip > taskboard.tar.gz
scp taskboard.tar.gz user@<host>:~/
```

On the server (after SSH):

```bash
docker load < taskboard.tar.gz
# or if you kept it gzipped:
gunzip -c taskboard.tar.gz | docker load
```

**Option B — Pipe over SSH (no temp file on server)**

On your machine:

```bash
docker save taskboard:latest | gzip | ssh user@<host> 'gunzip | docker load'
```

## 3. Run the container on the server

SSH into the host, then:

```bash
docker run -d \
  --name taskboard \
  -p 5173:5173 \
  -e TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}" \
  -e TaskBoard__AuthToken="${TASKBOARD_TOKEN:-dev-token}" \
  -v taskboard-data:/data \
  --restart unless-stopped \
  taskboard:latest
```

**Start on boot:** `--restart unless-stopped` makes Docker start the container automatically when the server boots (as long as Docker is enabled: `systemctl enable docker`).

- **`-p 5173:5173`** — app listens on 5173 inside the container; host port 5173 is published.
- **`-e TASKBOARD_TOKEN`** and **`-e TaskBoard__AuthToken`** — API bearer token (use both so the app accepts the token; default `dev-token`).
- **`-v taskboard-data:/data`** — SQLite DB is stored in a named volume so it survives container restarts.

## 4. Check it’s running

```bash
curl http://localhost:5173/healthz
# {"ok":true}
```

Open **http://&lt;host&gt;:5173** in a browser. Use token **`dev-token`** (or whatever you set).

## 5. Update (redeploy) — database preserved

On your machine: rebuild, save, and send the new image (same as steps 1–2). On the server:

```bash
docker stop taskboard
docker rm taskboard
docker load < taskboard.tar.gz   # or use the pipe-over-ssh method
docker run -d --name taskboard -p 5173:5173 \
  -e TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}" \
  -e TaskBoard__AuthToken="${TASKBOARD_TOKEN:-dev-token}" \
  -v taskboard-data:/data \
  --restart unless-stopped \
  taskboard:latest
```

The **same volume** `taskboard-data` keeps your SQLite DB across updates. Only remove the *container* (`docker rm taskboard`); **do not** run `docker volume rm taskboard-data` or you will lose the database.

## Server requirements

- **Docker** only (no .NET, Node, or repo on the server).
- Install Docker: [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) (e.g. Ubuntu: `curl -fsSL https://get.docker.com | sh`).

## Quick reference

| Item        | Value |
|------------|--------|
| Image      | `taskboard:latest` |
| URL        | http://&lt;host&gt;:5173 |
| API token  | `dev-token` (or set `TASKBOARD_TOKEN`) |
| DB volume  | `taskboard-data` (persists SQLite) |
