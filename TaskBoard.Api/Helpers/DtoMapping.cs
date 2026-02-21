using System.Text.Json;
using TaskBoard.Api.Contracts;
using TaskBoard.Api.Data;

namespace TaskBoard.Api.Helpers;

public static class DtoMapping
{
    public static TicketDto ToTicketDto(TicketEntity ticket, RunEntity? run) => new(
        ticket.Id,
        ticket.Title,
        ticket.Status.ToString(),
        ticket.Priority,
        ticket.Repo,
        DeserializeList(ticket.LabelsJson),
        DeserializeList(ticket.AcceptanceCriteriaJson),
        ticket.TestPlan,
        ticket.Description,
        ticket.CreatedAt,
        ticket.UpdatedAt,
        run is null ? null : ToRunDto(run));

    public static RunDto ToRunDto(RunEntity run) => new(
        run.TicketId,
        run.Phase.ToString().ToLowerInvariant(),
        run.Attempt,
        run.LockOwner,
        run.LockExpiresAt,
        run.Branch,
        run.PrNumber,
        run.LastCiState.ToString().ToLowerInvariant(),
        run.LastSummary,
        run.LastError,
        run.UpdatedAt);

    public static EventDto ToEventDto(EventEntity entity)
    {
        object payload;
        try
        {
            payload = JsonSerializer.Deserialize<object>(entity.PayloadJson) ?? new { };
        }
        catch
        {
            payload = new { raw = entity.PayloadJson };
        }

        return new EventDto(entity.Id, entity.TicketId, entity.Type, payload, entity.CreatedAt);
    }

    public static string SerializeList(List<string>? values)
    {
        var normalized = values is null
            ? []
            : values
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Select(v => v.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

        return JsonSerializer.Serialize(normalized);
    }

    public static List<string> DeserializeList(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<string>>(json) ?? [];
        }
        catch
        {
            return [];
        }
    }
}
