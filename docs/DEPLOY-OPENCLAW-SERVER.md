# Deploy TaskBoard (production)

Goal: run TaskBoard so it’s reachable on port 5173 (locally and, if bound to 0.0.0.0, from other machines).

**All scripts assume they run on the server.** You SSH into the host and copy the code there yourself; no SSH or remote commands are used inside the scripts.

## 1. SSH into the host (you do this manually)

```bash
ssh user@<host>
```

## 2. Get the code onto the host

**Option A — Clone (if the repo is on GitHub):**

```bash
git clone https://github.com/YOUR_ORG/dark-factory-board.git
cd dark-factory-board
```

**Option B — Copy from your machine:**

```bash
scp -r /path/to/dark-factory-board user@<host>:~/dark-factory-board
```

Then on the host:

```bash
cd ~/dark-factory-board
```

## 3. Run the deploy script

```bash
chmod +x scripts/deploy-openclaw-server.sh
./scripts/deploy-openclaw-server.sh
```

The script will:

- Install .NET 9 (or 8) SDK and Node 20 if missing (Ubuntu/Debian)
- Build the UI and copy it into the API `wwwroot`
- Publish the API and start it on **0.0.0.0:5173**

You’ll then have:

- **Local:** http://localhost:5173  
- **Remote:** http://&lt;host&gt;:5173  

Default API token: **`dev-token`**. Override with:

```bash
TASKBOARD_TOKEN=your-secret-token ./scripts/deploy-openclaw-server.sh
```

## 4. Run in the background (optional)

To keep it running after you close SSH:

```bash
cd ~/dark-factory-board
export ASPNETCORE_URLS="http://0.0.0.0:5173"
export TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
export ASPNETCORE_ENVIRONMENT=Production
nohup ./out/TaskBoard.Api > taskboard.log 2>&1 &
```

## 5. Firewall

If you can’t reach the app from another machine, open the port:

```bash
# Ubuntu/Debian with ufw
sudo ufw allow 5173/tcp
sudo ufw reload
```

## Quick reference

| Item       | Value |
|------------|--------|
| URL        | http://&lt;host&gt;:5173 |
| API token  | `dev-token` (or set `TASKBOARD_TOKEN`) |
