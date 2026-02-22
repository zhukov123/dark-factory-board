using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TaskBoard.Api.Contracts;
using TaskBoard.Api.Data;
using TaskBoard.Api.Domain;
using TaskBoard.Api.Helpers;
using TaskBoard.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader();
    });
});

builder.Services.AddDbContext<TaskBoardDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("Default") ?? "Data Source=taskboard.db"));
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower;
    options.SerializerOptions.PropertyNameCaseInsensitive = true;
});
builder.Services.AddScoped<TicketIdService>();
builder.Services.AddSingleton<DagService>();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

app.UseCors();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<TaskBoardDbContext>();
    await db.Database.MigrateAsync();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

var protectedSegments = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "tickets",
    "runs",
    "eligible",
    "pick-next",
    "validate",
    "events",
    "deps"
};

// Only serve static files for non-API paths; otherwise POST /tickets/... hits static middleware and returns 405
app.UseWhen(
    context =>
    {
        var first = context.Request.Path.Value?
            .Split('/', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        return first is null || !protectedSegments.Contains(first);
    },
    appBuilder =>
    {
        appBuilder.UseDefaultFiles();
        appBuilder.UseStaticFiles();
    });

app.Use(async (context, next) =>
{
    var firstSegment = context.Request.Path.Value?
        .Split('/', StringSplitOptions.RemoveEmptyEntries)
        .FirstOrDefault();

    if (firstSegment is null || !protectedSegments.Contains(firstSegment))
    {
        await next();
        return;
    }

    var expectedToken = builder.Configuration["TaskBoard:AuthToken"]
        ?? Environment.GetEnvironmentVariable("TASKBOARD_TOKEN")
        ?? string.Empty;

    var authHeader = context.Request.Headers.Authorization.ToString();
    if (!authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = "missing bearer token" });
        return;
    }

    var actualToken = authHeader["Bearer ".Length..].Trim();
    if (string.IsNullOrWhiteSpace(expectedToken))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = "invalid token" });
        return;
    }
    var expectedBytes = Encoding.UTF8.GetBytes(expectedToken);
    var actualBytes = Encoding.UTF8.GetBytes(actualToken);
    if (expectedBytes.Length != actualBytes.Length || !CryptographicOperations.FixedTimeEquals(expectedBytes.AsSpan(), actualBytes.AsSpan()))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = "invalid token" });
        return;
    }

    await next();
});

app.MapGet("/healthz", () => Results.Ok(new { ok = true }));

app.MapPost("/tickets", async (
    CreateTicketRequest request,
    TaskBoardDbContext db,
    TicketIdService ticketIdService,
    CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(request.Title))
    {
        return Results.BadRequest(new { error = "title is required" });
    }

    var hasParsedStatus = request.Status is not null;
    var parsedCreateStatus = TicketStatus.Backlog;
    if (hasParsedStatus && !EnumParsers.TryParseTicketStatus(request.Status, out parsedCreateStatus))
    {
        return Results.BadRequest(new { error = "invalid status" });
    }

    var now = DateTime.UtcNow;
    var id = await ticketIdService.NextTicketIdAsync(db, cancellationToken);

    var entity = new TicketEntity
    {
        Id = id,
        Title = request.Title.Trim(),
        Status = hasParsedStatus ? parsedCreateStatus : TicketStatus.Backlog,
        Priority = request.Priority ?? 0,
        Repo = request.Repo?.Trim() ?? string.Empty,
        LabelsJson = DtoMapping.SerializeList(request.Labels),
        AcceptanceCriteriaJson = DtoMapping.SerializeList(request.AcceptanceCriteria),
        TestPlan = request.TestPlan,
        Description = request.Description,
        CreatedAt = now,
        UpdatedAt = now
    };

    db.Tickets.Add(entity);
    db.Events.Add(new EventEntity
    {
        TicketId = entity.Id,
        Type = "ticket.created",
        PayloadJson = JsonSerializer.Serialize(new { entity.Id, entity.Title }),
        CreatedAt = now
    });

    await db.SaveChangesAsync(cancellationToken);

    return Results.Created($"/tickets/{entity.Id}", DtoMapping.ToTicketDto(entity, null));
});

app.MapGet("/tickets/{id}", async (string id, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    var ticket = await db.Tickets
        .Include(t => t.Run)
        .SingleOrDefaultAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);

    return ticket is null
        ? Results.NotFound(new { error = "ticket not found" })
        : Results.Ok(DtoMapping.ToTicketDto(ticket, ticket.Run));
});

app.MapGet("/tickets", async (
    string? status,
    string? repo,
    string? label,
    string? q,
    int? limit,
    int? offset,
    TaskBoardDbContext db,
    CancellationToken cancellationToken) =>
{
    var query = db.Tickets
        .Include(t => t.Run)
        .Where(t => !t.IsDeleted)
        .AsNoTracking()
        .AsQueryable();

    if (!string.IsNullOrWhiteSpace(status))
    {
        if (!EnumParsers.TryParseTicketStatus(status, out var parsedStatus))
        {
            return Results.BadRequest(new { error = "invalid status" });
        }

        query = query.Where(t => t.Status == parsedStatus);
    }

    if (!string.IsNullOrWhiteSpace(repo))
    {
        query = query.Where(t => t.Repo == repo);
    }

    if (!string.IsNullOrWhiteSpace(label))
    {
        query = query.Where(t => t.LabelsJson.Contains($"\"{label}\""));
    }

    if (!string.IsNullOrWhiteSpace(q))
    {
        query = query.Where(t => t.Title.Contains(q) || (t.Description != null && t.Description.Contains(q)));
    }

    var total = await query.CountAsync(cancellationToken);
    var pageSize = Math.Clamp(limit ?? 100, 1, 500);
    var skip = Math.Max(offset ?? 0, 0);

    var tickets = await query
        .OrderByDescending(t => t.UpdatedAt)
        .Skip(skip)
        .Take(pageSize)
        .ToListAsync(cancellationToken);

    return Results.Ok(new
    {
        total,
        limit = pageSize,
        offset = skip,
        items = tickets.Select(t => DtoMapping.ToTicketDto(t, t.Run)).ToList()
    });
});

app.MapPatch("/tickets/{id}", async (string id, PatchTicketRequest request, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    var ticket = await db.Tickets.SingleOrDefaultAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);
    if (ticket is null)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    var hasPatchStatus = request.Status is not null;
    var parsedPatchStatus = TicketStatus.Backlog;
    if (hasPatchStatus && !EnumParsers.TryParseTicketStatus(request.Status, out parsedPatchStatus))
    {
        return Results.BadRequest(new { error = "invalid status" });
    }

    if (request.Title is not null)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            return Results.BadRequest(new { error = "title cannot be empty" });
        }

        ticket.Title = request.Title.Trim();
    }

    if (hasPatchStatus)
    {
        ticket.Status = parsedPatchStatus;
    }

    if (request.Priority.HasValue)
    {
        ticket.Priority = request.Priority.Value;
    }

    if (request.Repo is not null)
    {
        ticket.Repo = request.Repo.Trim();
    }

    if (request.Labels is not null)
    {
        ticket.LabelsJson = DtoMapping.SerializeList(request.Labels);
    }

    if (request.AcceptanceCriteria is not null)
    {
        ticket.AcceptanceCriteriaJson = DtoMapping.SerializeList(request.AcceptanceCriteria);
    }

    if (request.TestPlan is not null)
    {
        ticket.TestPlan = request.TestPlan;
    }

    if (request.Description is not null)
    {
        ticket.Description = request.Description;
    }

    ticket.UpdatedAt = DateTime.UtcNow;
    await db.SaveChangesAsync(cancellationToken);

    var run = await db.Runs.SingleOrDefaultAsync(r => r.TicketId == id, cancellationToken);
    return Results.Ok(DtoMapping.ToTicketDto(ticket, run));
});

app.MapDelete("/tickets/{id}", async (string id, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    var ticket = await db.Tickets.SingleOrDefaultAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);
    if (ticket is null)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    var now = DateTime.UtcNow;
    ticket.IsDeleted = true;
    ticket.DeletedAt = now;
    ticket.UpdatedAt = now;

    db.Events.Add(new EventEntity
    {
        TicketId = ticket.Id,
        Type = "ticket.deleted",
        PayloadJson = JsonSerializer.Serialize(new { ticket.Id }),
        CreatedAt = now
    });

    await db.SaveChangesAsync(cancellationToken);
    return Results.NoContent();
});

app.MapGet("/tickets/{id}/deps", async (string id, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    var exists = await db.Tickets.AnyAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);
    if (!exists)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    var blockedBy = await db.Dependencies
        .Where(d => d.TicketId == id)
        .Join(
            db.Tickets.Where(t => !t.IsDeleted),
            dep => dep.BlockedById,
            ticket => ticket.Id,
            (dep, _) => dep.BlockedById)
        .OrderBy(depId => depId)
        .ToListAsync(cancellationToken);

    var blocks = await db.Dependencies
        .Where(d => d.BlockedById == id)
        .Join(
            db.Tickets.Where(t => !t.IsDeleted),
            dep => dep.TicketId,
            ticket => ticket.Id,
            (dep, _) => dep.TicketId)
        .OrderBy(depId => depId)
        .ToListAsync(cancellationToken);

    return Results.Ok(new { blocked_by = blockedBy, blocks });
});

app.MapGet("/deps", async (string? ids, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    var ticketIds = (ids ?? "")
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Where(s => s.Length > 0)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToList();

    if (ticketIds.Count == 0)
    {
        return Results.Ok(new Dictionary<string, object>());
    }

    var activeIds = await db.Tickets
        .Where(t => ticketIds.Contains(t.Id) && !t.IsDeleted)
        .Select(t => t.Id)
        .ToListAsync(cancellationToken);

    var deps = await db.Dependencies
        .Where(d => activeIds.Contains(d.TicketId) && activeIds.Contains(d.BlockedById))
        .ToListAsync(cancellationToken);

    var blockedByLookup = deps
        .GroupBy(d => d.TicketId, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(g => g.Key, g => g.Select(x => x.BlockedById).OrderBy(x => x, StringComparer.Ordinal).ToList(), StringComparer.OrdinalIgnoreCase);
    var blocksLookup = deps
        .GroupBy(d => d.BlockedById, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(g => g.Key, g => g.Select(x => x.TicketId).OrderBy(x => x, StringComparer.Ordinal).ToList(), StringComparer.OrdinalIgnoreCase);

    var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
    foreach (var id in ticketIds)
    {
        result[id] = new
        {
            blocked_by = blockedByLookup.GetValueOrDefault(id) ?? [],
            blocks = blocksLookup.GetValueOrDefault(id) ?? []
        };
    }

    return Results.Ok(result);
});

app.MapPut("/tickets/{id}/deps", async (
    string id,
    PutDependenciesRequest request,
    TaskBoardDbContext db,
    DagService dagService,
    CancellationToken cancellationToken) =>
{
    var ticket = await db.Tickets.SingleOrDefaultAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);
    if (ticket is null)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    var blockedBy = (request.BlockedBy ?? [])
        .Where(v => !string.IsNullOrWhiteSpace(v))
        .Select(v => v.Trim())
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToList();

    if (blockedBy.Any(dep => dep.Equals(id, StringComparison.OrdinalIgnoreCase)))
    {
        return Results.BadRequest(new { error = "self dependency is not allowed" });
    }

    var targets = await db.Tickets
        .Where(t => blockedBy.Contains(t.Id) && !t.IsDeleted)
        .Select(t => t.Id)
        .ToListAsync(cancellationToken);

    if (targets.Count != blockedBy.Count)
    {
        var missing = blockedBy.Except(targets, StringComparer.OrdinalIgnoreCase).ToList();
        return Results.BadRequest(new { error = "blocked_by ticket not found", missing });
    }

    var activeTickets = await db.Tickets
        .Where(t => !t.IsDeleted)
        .Select(t => t.Id)
        .ToListAsync(cancellationToken);

    var dependencies = await db.Dependencies
        .Where(d => activeTickets.Contains(d.TicketId) && activeTickets.Contains(d.BlockedById))
        .ToListAsync(cancellationToken);

    var blockersByTicket = dagService.BuildBlockersByTicket(activeTickets, dependencies);
    if (dagService.WouldIntroduceCycle(activeTickets, blockersByTicket, id, blockedBy, out var cyclePath))
    {
        return Results.Conflict(new { error = "dependency cycle detected", cycle = cyclePath });
    }

    var existing = await db.Dependencies.Where(d => d.TicketId == id).ToListAsync(cancellationToken);
    db.Dependencies.RemoveRange(existing);

    foreach (var blockedById in blockedBy)
    {
        db.Dependencies.Add(new DependencyEntity
        {
            TicketId = id,
            BlockedById = blockedById
        });
    }

    db.Events.Add(new EventEntity
    {
        TicketId = id,
        Type = "ticket.deps.updated",
        PayloadJson = JsonSerializer.Serialize(new { blocked_by = blockedBy }),
        CreatedAt = DateTime.UtcNow
    });

    await db.SaveChangesAsync(cancellationToken);
    return Results.NoContent();
});

app.MapPost("/tickets/{id}/transition", async (
    string id,
    TransitionTicketRequest request,
    TaskBoardDbContext db,
    CancellationToken cancellationToken) =>
{
    var ticket = await db.Tickets.SingleOrDefaultAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);
    if (ticket is null)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    if (!EnumParsers.TryParseTicketStatus(request.To, out var toStatus))
    {
        return Results.BadRequest(new { error = "invalid target status" });
    }

    var force = request.Force == true;
    if (ticket.Status == TicketStatus.Done && toStatus == TicketStatus.InProgress && !force)
    {
        return Results.BadRequest(new { error = "Done -> InProgress requires force=true" });
    }

    var fromStatus = ticket.Status;
    ticket.Status = toStatus;
    ticket.UpdatedAt = DateTime.UtcNow;

    db.Events.Add(new EventEntity
    {
        TicketId = id,
        Type = "ticket.transition",
        PayloadJson = JsonSerializer.Serialize(new
        {
            from = fromStatus.ToString(),
            to = toStatus.ToString(),
            request.Note,
            request.By,
            force
        }),
        CreatedAt = DateTime.UtcNow
    });

    await db.SaveChangesAsync(cancellationToken);
    var run = await db.Runs.SingleOrDefaultAsync(r => r.TicketId == id, cancellationToken);

    return Results.Ok(DtoMapping.ToTicketDto(ticket, run));
});

app.MapPost("/runs/acquire", async (
    AcquireRunRequest request,
    TaskBoardDbContext db,
    CancellationToken cancellationToken) =>
{
    var ticketExists = await db.Tickets.AnyAsync(t => t.Id == request.TicketId && !t.IsDeleted, cancellationToken);
    if (!ticketExists)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    if (request.TtlSeconds <= 0)
    {
        return Results.BadRequest(new { error = "ttl_seconds must be greater than 0" });
    }

    var now = DateTime.UtcNow;
    var run = await db.Runs.SingleOrDefaultAsync(r => r.TicketId == request.TicketId, cancellationToken);
    if (run is null)
    {
        run = new RunEntity
        {
            TicketId = request.TicketId,
            Phase = RunPhase.Plan,
            Attempt = 0,
            LastCiState = CiState.Unknown,
            UpdatedAt = now
        };
        db.Runs.Add(run);
    }

    var isLockedByAnother =
        run.LockOwner is not null
        && !run.LockOwner.Equals(request.Owner, StringComparison.Ordinal)
        && run.LockExpiresAt.HasValue
        && run.LockExpiresAt.Value > now;

    var acquired = !isLockedByAnother;
    if (acquired)
    {
        run.LockOwner = request.Owner;
        run.LockExpiresAt = now.AddSeconds(request.TtlSeconds);
        run.UpdatedAt = now;
    }

    await db.SaveChangesAsync(cancellationToken);

    return Results.Ok(new
    {
        acquired,
        run = DtoMapping.ToRunDto(run)
    });
});

app.MapPost("/runs/heartbeat", async (
    HeartbeatRunRequest request,
    TaskBoardDbContext db,
    CancellationToken cancellationToken) =>
{
    if (request.TtlSeconds <= 0)
    {
        return Results.BadRequest(new { error = "ttl_seconds must be greater than 0" });
    }

    var run = await db.Runs.SingleOrDefaultAsync(r => r.TicketId == request.TicketId, cancellationToken);
    if (run is null)
    {
        return Results.NotFound(new { error = "run not found" });
    }

    var now = DateTime.UtcNow;
    if (run.LockOwner is null
        || !run.LockOwner.Equals(request.Owner, StringComparison.Ordinal)
        || !run.LockExpiresAt.HasValue
        || run.LockExpiresAt.Value <= now)
    {
        return Results.Conflict(new { ok = false, error = "lock not held by owner or expired" });
    }

    run.LockExpiresAt = now.AddSeconds(request.TtlSeconds);
    run.UpdatedAt = now;

    await db.SaveChangesAsync(cancellationToken);

    return Results.Ok(new
    {
        ok = true,
        run = DtoMapping.ToRunDto(run)
    });
});

app.MapPatch("/runs/{ticketId}", async (
    string ticketId,
    PatchRunRequest request,
    TaskBoardDbContext db,
    CancellationToken cancellationToken) =>
{
    var ticketExists = await db.Tickets.AnyAsync(t => t.Id == ticketId && !t.IsDeleted, cancellationToken);
    if (!ticketExists)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    var run = await db.Runs.SingleOrDefaultAsync(r => r.TicketId == ticketId, cancellationToken);
    if (run is null)
    {
        return Results.NotFound(new { error = "run not found" });
    }

    if (request.Phase is not null)
    {
        if (!EnumParsers.TryParseRunPhase(request.Phase, out var phase))
        {
            return Results.BadRequest(new { error = "invalid phase" });
        }

        run.Phase = phase;
    }

    if (request.Attempt.HasValue)
    {
        run.Attempt = request.Attempt.Value;
    }

    if (request.Branch is not null)
    {
        run.Branch = request.Branch;
    }

    if (request.PrNumber.HasValue)
    {
        run.PrNumber = request.PrNumber;
    }

    if (request.LastCiState is not null)
    {
        if (!EnumParsers.TryParseCiState(request.LastCiState, out var state))
        {
            return Results.BadRequest(new { error = "invalid ci state" });
        }

        run.LastCiState = state;
    }

    if (request.LastSummary is not null)
    {
        run.LastSummary = request.LastSummary;
    }

    if (request.LastError is not null)
    {
        run.LastError = request.LastError;
    }

    run.UpdatedAt = DateTime.UtcNow;

    db.Events.Add(new EventEntity
    {
        TicketId = ticketId,
        Type = "run.update",
        PayloadJson = JsonSerializer.Serialize(request),
        CreatedAt = DateTime.UtcNow
    });

    await db.SaveChangesAsync(cancellationToken);

    return Results.Ok(DtoMapping.ToRunDto(run));
});

app.MapGet("/eligible", async (
    string? repo,
    TaskBoardDbContext db,
    DagService dagService,
    CancellationToken cancellationToken) =>
{
    var now = DateTime.UtcNow;
    var allTickets = await db.Tickets
        .Where(t => !t.IsDeleted)
        .OrderBy(t => t.CreatedAt)
        .ToListAsync(cancellationToken);

    var ticketIds = allTickets.Select(t => t.Id).ToList();
    var deps = await db.Dependencies
        .Where(d => ticketIds.Contains(d.TicketId) && ticketIds.Contains(d.BlockedById))
        .ToListAsync(cancellationToken);

    var blockersByTicket = dagService.BuildBlockersByTicket(ticketIds, deps);

    var activeLockIds = await db.Runs
        .Where(r => r.LockOwner != null && r.LockExpiresAt.HasValue && r.LockExpiresAt > now)
        .Select(r => r.TicketId)
        .ToListAsync(cancellationToken);
    var activeLocks = activeLockIds.ToHashSet(StringComparer.OrdinalIgnoreCase);

    var eligibleIds = dagService.ComputeEligibleIds(allTickets, blockersByTicket, activeLocks);

    var filtered = allTickets
        .Where(t => eligibleIds.Contains(t.Id) && (string.IsNullOrWhiteSpace(repo) || t.Repo == repo))
        .Select(t => new EligibleTicketDto(
            t.Id,
            t.Title,
            t.Priority,
            t.Repo,
            blockersByTicket.GetValueOrDefault(t.Id)?.Count ?? 0,
            t.Status.ToString()))
        .ToList();

    return Results.Ok(filtered);
});

app.MapGet("/pick-next", async (
    string? repo,
    TaskBoardDbContext db,
    DagService dagService,
    CancellationToken cancellationToken) =>
{
    var now = DateTime.UtcNow;
    var allTickets = await db.Tickets
        .Where(t => !t.IsDeleted)
        .ToListAsync(cancellationToken);

    var ticketIds = allTickets.Select(t => t.Id).ToList();
    var deps = await db.Dependencies
        .Where(d => ticketIds.Contains(d.TicketId) && ticketIds.Contains(d.BlockedById))
        .ToListAsync(cancellationToken);

    var blockersByTicket = dagService.BuildBlockersByTicket(ticketIds, deps);
    var downstreamByTicket = dagService.BuildDownstreamByTicket(ticketIds, deps);

    var activeLockIds = await db.Runs
        .Where(r => r.LockOwner != null && r.LockExpiresAt.HasValue && r.LockExpiresAt > now)
        .Select(r => r.TicketId)
        .ToListAsync(cancellationToken);
    var activeLocks = activeLockIds.ToHashSet(StringComparer.OrdinalIgnoreCase);

    var eligibleIds = dagService.ComputeEligibleIds(allTickets, blockersByTicket, activeLocks);

    var candidates = allTickets
        .Where(t => eligibleIds.Contains(t.Id) && (string.IsNullOrWhiteSpace(repo) || t.Repo == repo))
        .ToList();

    if (candidates.Count == 0)
    {
        return Results.Ok(new PickNextResult(null, null, null, "none eligible"));
    }

    var scored = candidates
        .Select(ticket =>
        {
            var downstreamUnblocked = dagService.ComputeDownstreamUnblockedSimulationCount(ticket.Id, allTickets, blockersByTicket, activeLocks);
            var criticalPath = dagService.ComputeCriticalPathDepth(ticket.Id, downstreamByTicket);
            var score = (10 * downstreamUnblocked) + (5 * criticalPath) + ticket.Priority;
            var reasons = new PickNextReasons(
                DownstreamUnblockedCount: downstreamUnblocked,
                CriticalPathDepth: criticalPath,
                Priority: ticket.Priority,
                Score: score,
                HasActiveLock: false,
                AllBlockersDone: true);

            return new
            {
                Ticket = ticket,
                Score = score,
                Reasons = reasons
            };
        })
        .OrderByDescending(x => x.Score)
        .ThenByDescending(x => x.Ticket.Priority)
        .ThenBy(x => x.Ticket.CreatedAt)
        .ThenBy(x => x.Ticket.Id, StringComparer.Ordinal)
        .ToList();

    var selected = scored[0];

    return Results.Ok(new PickNextResult(selected.Ticket.Id, selected.Score, selected.Reasons, null));
});

app.MapGet("/validate", async (TaskBoardDbContext db, DagService dagService, CancellationToken cancellationToken) =>
{
    var activeTickets = await db.Tickets
        .Where(t => !t.IsDeleted)
        .Select(t => t.Id)
        .ToListAsync(cancellationToken);

    var deps = await db.Dependencies
        .Where(d => activeTickets.Contains(d.TicketId) && activeTickets.Contains(d.BlockedById))
        .ToListAsync(cancellationToken);

    var blockersByTicket = dagService.BuildBlockersByTicket(activeTickets, deps);
    if (dagService.TryFindCycle(activeTickets, blockersByTicket, out var cyclePath))
    {
        return Results.Ok(new { ok = false, cycles = new[] { cyclePath } });
    }

    return Results.Ok(new { ok = true, cycles = Array.Empty<string[]>() });
});

app.MapPost("/tickets/{id}/updates", async (string id, PostTicketUpdateRequest request, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    var ticket = await db.Tickets.SingleOrDefaultAsync(t => t.Id == id && !t.IsDeleted, cancellationToken);
    if (ticket is null)
    {
        return Results.NotFound(new { error = "ticket not found" });
    }

    if (string.IsNullOrWhiteSpace(request.Message))
    {
        return Results.BadRequest(new { error = "message is required" });
    }

    var now = DateTime.UtcNow;
    var payload = new
    {
        message = request.Message.Trim(),
        author = string.IsNullOrWhiteSpace(request.Author) ? "user" : request.Author.Trim(),
        at = now
    };

    var entity = new EventEntity
    {
        TicketId = id,
        Type = "ticket.update",
        PayloadJson = JsonSerializer.Serialize(payload),
        CreatedAt = now
    };

    db.Events.Add(entity);
    await db.SaveChangesAsync(cancellationToken);

    return Results.Created($"/events/{entity.Id}", DtoMapping.ToEventDto(entity));
});

app.MapPost("/events", async (CreateEventRequest request, TaskBoardDbContext db, CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(request.Type))
    {
        return Results.BadRequest(new { error = "type is required" });
    }

    if (!string.IsNullOrWhiteSpace(request.TicketId))
    {
        var ticketExists = await db.Tickets.AnyAsync(t => t.Id == request.TicketId && !t.IsDeleted, cancellationToken);
        if (!ticketExists)
        {
            return Results.BadRequest(new { error = "ticket_id not found" });
        }
    }

    var entity = new EventEntity
    {
        TicketId = request.TicketId,
        Type = request.Type,
        PayloadJson = JsonSerializer.Serialize(request.Payload ?? new { }),
        CreatedAt = DateTime.UtcNow
    };

    db.Events.Add(entity);
    await db.SaveChangesAsync(cancellationToken);

    return Results.Created($"/events/{entity.Id}", DtoMapping.ToEventDto(entity));
});

app.MapGet("/events", async (
    string? ticket_id,
    string? type,
    DateTime? since,
    int? limit,
    TaskBoardDbContext db,
    CancellationToken cancellationToken) =>
{
    var take = Math.Clamp(limit ?? 100, 1, 500);

    var query = db.Events.AsQueryable();

    if (!string.IsNullOrWhiteSpace(ticket_id))
    {
        query = query.Where(e => e.TicketId == ticket_id);
    }

    if (!string.IsNullOrWhiteSpace(type))
    {
        query = query.Where(e => e.Type == type);
    }

    if (since.HasValue)
    {
        query = query.Where(e => e.CreatedAt >= since.Value);
    }

    var events = await query
        .OrderByDescending(e => e.CreatedAt)
        .ThenByDescending(e => e.Id)
        .Take(take)
        .ToListAsync(cancellationToken);

    return Results.Ok(events.Select(DtoMapping.ToEventDto).ToList());
});

app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
