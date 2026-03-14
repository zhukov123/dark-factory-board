using TaskBoard.Api.Domain;

namespace TaskBoard.Api.Data;

public sealed class TicketEntity
{
    public string Id { get; set; } = default!;
    public string Title { get; set; } = default!;
    public TicketStatus Status { get; set; } = TicketStatus.Backlog;
    public int Priority { get; set; }
    public string Repo { get; set; } = string.Empty;
    public string LabelsJson { get; set; } = "[]";
    public string AcceptanceCriteriaJson { get; set; } = "[]";
    public string? TestPlan { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }

    public RunEntity? Run { get; set; }
    public List<AttachmentEntity> Attachments { get; set; } = [];
    public List<DependencyEntity> BlockedBy { get; set; } = [];
    public List<DependencyEntity> Blocks { get; set; } = [];
    public List<EventEntity> Events { get; set; } = [];
}

public sealed class DependencyEntity
{
    public string TicketId { get; set; } = default!;
    public string BlockedById { get; set; } = default!;

    public TicketEntity Ticket { get; set; } = default!;
    public TicketEntity BlockedBy { get; set; } = default!;
}

public sealed class RunEntity
{
    public string TicketId { get; set; } = default!;
    public RunPhase Phase { get; set; } = RunPhase.Plan;
    public int Attempt { get; set; }
    public string? LockOwner { get; set; }
    public DateTime? LockExpiresAt { get; set; }
    public string? Branch { get; set; }
    public int? PrNumber { get; set; }
    public string? PrUrl { get; set; }
    public CiState LastCiState { get; set; } = CiState.Unknown;
    public string? LastSummary { get; set; }
    public string? LastError { get; set; }
    public string? PendingApprovalDecisionId { get; set; }
    public string? WorkflowId { get; set; }
    public DateTime UpdatedAt { get; set; }

    public TicketEntity Ticket { get; set; } = default!;
}

public sealed class AttachmentEntity
{
    public long Id { get; set; }
    public string TicketId { get; set; } = default!;
    public string Name { get; set; } = default!;
    public string? ContentType { get; set; }
    public long Size { get; set; }
    public string StoragePath { get; set; } = default!;
    public DateTime CreatedAt { get; set; }

    public TicketEntity Ticket { get; set; } = default!;
}

public sealed class EventEntity
{
    public long Id { get; set; }
    public string? TicketId { get; set; }
    public string Type { get; set; } = default!;
    public string PayloadJson { get; set; } = "{}";
    public DateTime CreatedAt { get; set; }

    public TicketEntity? Ticket { get; set; }
}

public sealed class CounterEntity
{
    public string Key { get; set; } = default!;
    public string Value { get; set; } = default!;
}
