using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace TaskBoard.Api.Services;

/// <summary>
/// In-memory broadcaster for LLM token stream. Worker POSTs chunks; GET /stream/llm subscribers receive them as SSE.
/// </summary>
public sealed class LlmStreamBroadcaster
{
    private readonly struct Subscriber
    {
        public string? TicketIdFilter { get; }
        public Stream ResponseBody { get; }
        public CancellationToken CancellationToken { get; }

        public Subscriber(string? ticketIdFilter, Stream responseBody, CancellationToken cancellationToken)
        {
            TicketIdFilter = ticketIdFilter;
            ResponseBody = responseBody;
            CancellationToken = cancellationToken;
        }
    }

    private readonly ConcurrentDictionary<Guid, Subscriber> _subscribers = new();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    /// <summary>Register an SSE client. Keep the connection open; when Broadcast is called, data is written here.</summary>
    public Guid Subscribe(string? ticketIdFilter, Stream responseBody, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        _subscribers[id] = new Subscriber(ticketIdFilter, responseBody, ct);
        return id;
    }

    /// <summary>Remove a subscriber (e.g. on disconnect).</summary>
    public void Unsubscribe(Guid id) => _subscribers.TryRemove(id, out _);

    /// <summary>Broadcast one chunk to all subscribers (optionally filtered by ticket_id).</summary>
    public async Task BroadcastAsync(string ticketId, string phase, string delta, CancellationToken ct = default)
    {
        var payload = JsonSerializer.Serialize(new { ticket_id = ticketId, phase, delta }, JsonOptions);
        var data = $"data: {payload}\n\n";
        var bytes = Encoding.UTF8.GetBytes(data);

        var toRemove = new List<Guid>();
        foreach (var (id, sub) in _subscribers)
        {
            if (sub.CancellationToken.IsCancellationRequested)
            {
                toRemove.Add(id);
                continue;
            }
            if (sub.TicketIdFilter != null && !string.Equals(sub.TicketIdFilter, ticketId, StringComparison.OrdinalIgnoreCase))
                continue;
            try
            {
                await sub.ResponseBody.WriteAsync(bytes, ct);
                await sub.ResponseBody.FlushAsync(ct);
            }
            catch (OperationCanceledException)
            {
                toRemove.Add(id);
            }
            catch
            {
                toRemove.Add(id);
            }
        }
        foreach (var id in toRemove)
            _subscribers.TryRemove(id, out _);
    }
}
