# TaskBoard v1

TaskBoard v1 is a dependency-aware Kanban system for orchestrated software execution.

Projects:
- `TaskBoard.Api` - .NET 8 Minimal API + EF Core + SQLite
- `TaskBoard.Ui` - React + TypeScript + Vite + React Query + `dnd-kit`
- `TaskBoard.Tests` - API integration tests (xUnit + WebApplicationFactory)

## Features

- Kanban board with drag/drop status transitions
- Ticket CRUD (soft delete)
- Dependency editing with acyclic validation and cycle-path conflict errors
- Run lock management (`/runs/acquire`, `/runs/heartbeat`, `/runs/{ticketId}` patch)
- Scheduler helpers (`/eligible`, `/pick-next`, `/validate`)
- Event log per ticket
- Orchestrator panel (eligible list, pick-next reasons, simulate-done)
- Dependency graph panel with cycle highlighting

## Requirements

- .NET SDK 8.x (or newer SDK with .NET 8 runtime installed)
- Node.js 20+
- npm 10+

## Development Run

API (`http://localhost:5005`):

```bash
dotnet run --project TaskBoard.Api --launch-profile http
```

UI (`http://localhost:5173`):

```bash
cd TaskBoard.Ui
npm install
npm run dev
```

UI auth setup:
- Token: `dev-token` (from `TaskBoard.Api/appsettings.Development.json`)
- API Base URL: leave empty to use Vite proxy, or set `http://localhost:5005`

### API auth

All API routes (except `/healthz` and swagger in development) require:

```http
Authorization: Bearer <token>
```

Token source precedence:
1. `TaskBoard:AuthToken` in config
2. `TASKBOARD_TOKEN` environment variable

## Dark Factory (worker + Temporal)

Optional Python worker runs the DarkFactoryRun workflow (pick task → claim → prepare → LangGraph → tests → PR → close).

1. **Start Temporal** (one of):
   - `docker compose -f docker-compose.temporal.yml up -d`
   - Or [Temporal CLI](https://docs.temporal.io/cli): `temporal server start-dev`
2. **Start TaskBoard API** (see Development Run above). Set `TASKBOARD_URL` to the API URL (e.g. `http://localhost:5005`).
3. **Run worker:**
   ```bash
   cd worker
   pip install -r requirements.txt
   export TASKBOARD_URL=http://localhost:5005 TASKBOARD_TOKEN=dev-token
   python main.py
   ```
4. Start a workflow via Temporal UI (default `http://localhost:8233`) or CLI:  
   `temporal workflow start --task-queue dark-factory --type DarkFactoryRun --input '{"owner":"worker-1","ttl_seconds":1800}'`

See `worker/README.md` for env vars (GITHUB_TOKEN, REPO_CLONE_ROOT, etc.).  
**E2E test:** [docs/E2E-TEST-DARK-FACTORY.md](docs/E2E-TEST-DARK-FACTORY.md) — start Temporal, API, seed tickets (`./scripts/seed-test-tickets.sh`), run worker, start workflow, verify tickets move Ready → Done.  
**Autonomous run:** [docs/AUTONOMOUS-RUN.md](docs/AUTONOMOUS-RUN.md) — `./scripts/run-autonomous-cycle.sh` and `./scripts/poll-status.sh` to process all stories and produce code in your workspace (requires LM Studio or OpenRouter).

## Production Build / Serve

1) Build UI:

```bash
cd TaskBoard.Ui
npm ci
npm run build
```

2) Copy UI static assets into API `wwwroot`:

```bash
cd ..
rm -rf TaskBoard.Api/wwwroot
mkdir -p TaskBoard.Api/wwwroot
cp -R TaskBoard.Ui/dist/* TaskBoard.Api/wwwroot/
```

3) Publish and run API:

```bash
TASKBOARD_TOKEN="<secure-token>" dotnet publish TaskBoard.Api -c Release -o out
TASKBOARD_TOKEN="<secure-token>" ./out/TaskBoard.Api
```

The API serves both backend routes and the built SPA from the same origin.

## Tests

API + integration tests:

```bash
dotnet build TaskBoard.sln
dotnet test TaskBoard.Tests/TaskBoard.Tests.csproj
```

UI sanity tests:

```bash
cd TaskBoard.Ui
npm test
```

## Manual verification script (v1 acceptance)

1. Start API and UI in dev mode.
2. Create tickets across multiple statuses.
3. Drag a ticket to a different status column and verify transition persists.
4. Open ticket detail and update fields; verify save roundtrip.
5. Set dependencies and verify:
   - valid dependency set saves
   - cycle-introducing update returns conflict
6. Open Orchestrator panel:
   - `/eligible` lists ready/unblocked/unlocked tickets
   - `/pick-next` returns score + reason breakdown
7. Open Dependency panel and verify `/validate` state and cycle highlight.
8. Open Events panel and verify transition/run updates appear.
9. Soft delete a ticket and verify it disappears from list and `GET /tickets/{id}` returns 404.
10. Run tests (`dotnet test`, `npm test`).

## Notes

- SQLite DB file defaults:
  - Development: `TaskBoard.Api/taskboard.dev.db`
  - Default: `TaskBoard.Api/taskboard.db`
- DB schema is created via EF Core migrations on API startup (`Database.Migrate()`).
