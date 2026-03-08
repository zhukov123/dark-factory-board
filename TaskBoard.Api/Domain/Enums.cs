namespace TaskBoard.Api.Domain;

public enum TicketStatus
{
    Backlog,
    Ready,
    InProgress,
    Review,
    Done,
    Blocked
}

public enum RunPhase
{
    Plan,
    Implement,
    Test,
    Review,
    Integrate,
    AwaitingApproval
}

public enum CiState
{
    Unknown,
    Pending,
    Success,
    Failure
}
