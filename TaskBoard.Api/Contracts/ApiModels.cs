using TaskBoard.Api.Domain;

namespace TaskBoard.Api.Contracts;

public sealed record CreateTicketRequest(
    string Title,
    string? Status,
    int? Priority,
    string? Repo,
    List<string>? Labels,
    List<string>? AcceptanceCriteria,
    string? TestPlan,
    string? Description);

public sealed record PatchTicketRequest(
    string? Title,
    string? Status,
    int? Priority,
    string? Repo,
    List<string>? Labels,
    List<string>? AcceptanceCriteria,
    string? TestPlan,
    string? Description);

public sealed record PutDependenciesRequest(List<string> BlockedBy);

public sealed record TransitionTicketRequest(string To, string? Note, string By, bool? Force);

public sealed record AcquireRunRequest(string TicketId, string Owner, int TtlSeconds);

public sealed record ClaimRunRequest(string TicketId, string Owner, int TtlSeconds);

public sealed record ReleaseRunRequest(string TicketId, string Owner);

public sealed record HeartbeatRunRequest(string TicketId, string Owner, int TtlSeconds);

public sealed record PatchRunRequest(
    string? Phase,
    int? Attempt,
    string? Branch,
    int? PrNumber,
    string? PrUrl,
    string? LastCiState,
    string? LastSummary,
    string? LastError,
    string? WorkflowId,
    string? PendingApprovalDecisionId);

public sealed record ApprovalDecisionRequest(string DecisionId, string? Note);

public sealed record CreateEventRequest(string? TicketId, string Type, object? Payload);

public sealed record PostTicketUpdateRequest(string Message, string? Author);

public sealed record TicketDto(
    string Id,
    string Title,
    string Status,
    int Priority,
    string Repo,
    List<string> Labels,
    List<string> AcceptanceCriteria,
    string? TestPlan,
    string? Description,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    RunDto? Run);

public sealed record RunDto(
    string TicketId,
    string Phase,
    int Attempt,
    string? LockOwner,
    DateTime? LockExpiresAt,
    string? Branch,
    int? PrNumber,
    string? PrUrl,
    string LastCiState,
    string? LastSummary,
    string? LastError,
    string? PendingApprovalDecisionId,
    string? WorkflowId,
    DateTime UpdatedAt);

public sealed record AttachmentDto(
    long Id,
    string TicketId,
    string Name,
    long Size,
    DateTime CreatedAt);

public sealed record AttachmentListResponse(IReadOnlyList<AttachmentDto> Items);

public sealed record UploadAttachmentJsonRequest(string Name, string? ContentType, string? Content);

public sealed record EventDto(long Id, string? TicketId, string Type, object Payload, DateTime CreatedAt);

public sealed record EligibleTicketDto(
    string TicketId,
    string Title,
    int Priority,
    string Repo,
    int Blockers,
    string Status);

public sealed record PickNextReasons(
    int DownstreamUnblockedCount,
    int CriticalPathDepth,
    int Priority,
    int Score,
    bool HasActiveLock,
    bool AllBlockersDone);

public sealed record PickNextResult(
    string? TicketId,
    int? Score,
    PickNextReasons? Reasons,
    string? Reason);

public static class EnumParsers
{
    public static bool TryParseTicketStatus(string? value, out TicketStatus status) =>
        Enum.TryParse(value, true, out status);

    public static bool TryParseRunPhase(string? value, out RunPhase phase) =>
        Enum.TryParse(value, true, out phase);

    public static bool TryParseCiState(string? value, out CiState state) =>
        Enum.TryParse(value, true, out state);
}
