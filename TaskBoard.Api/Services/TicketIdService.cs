using Microsoft.EntityFrameworkCore;
using TaskBoard.Api.Data;

namespace TaskBoard.Api.Services;

public sealed class TicketIdService
{
    private const string CounterKey = "ticket_next_number";

    public async Task<string> NextTicketIdAsync(TaskBoardDbContext dbContext, CancellationToken cancellationToken)
    {
        var counter = await dbContext.Counters.SingleOrDefaultAsync(c => c.Key == CounterKey, cancellationToken);
        if (counter is null)
        {
            counter = new CounterEntity
            {
                Key = CounterKey,
                Value = "2"
            };
            dbContext.Counters.Add(counter);
            return "T1";
        }

        if (!int.TryParse(counter.Value, out var nextId) || nextId < 1)
        {
            nextId = 1;
        }

        counter.Value = (nextId + 1).ToString();
        return $"T{nextId}";
    }
}
