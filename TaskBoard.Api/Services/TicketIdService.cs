using Microsoft.EntityFrameworkCore;
using TaskBoard.Api.Data;

namespace TaskBoard.Api.Services;

public sealed class TicketIdService
{
    private const string CounterKey = "ticket_next_number";

    /// <summary>
    /// Atomically increments the ticket counter and returns the next ticket id (e.g. T1, T2).
    /// Uses raw SQL with RETURNING to avoid race conditions under concurrent requests.
    /// </summary>
    public async Task<string> NextTicketIdAsync(TaskBoardDbContext dbContext, CancellationToken cancellationToken)
    {
        var conn = dbContext.Database.GetDbConnection();
        await conn.OpenAsync(cancellationToken);
        await using var transaction = await conn.BeginTransactionAsync(cancellationToken);

        try
        {
            // Ensure row exists (idempotent). Value 0 = no ticket assigned yet.
            await using (var ensureCmd = conn.CreateCommand())
            {
                ensureCmd.Transaction = transaction;
                ensureCmd.CommandText = "INSERT OR IGNORE INTO counters (key, value) VALUES ($key, '0')";
                var pKey = ensureCmd.CreateParameter();
                pKey.ParameterName = "$key";
                pKey.Value = CounterKey;
                ensureCmd.Parameters.Add(pKey);
                await ensureCmd.ExecuteNonQueryAsync(cancellationToken);
            }

            // Atomic increment and return new value.
            await using var updateCmd = conn.CreateCommand();
            updateCmd.Transaction = transaction;
            updateCmd.CommandText = "UPDATE counters SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = $key RETURNING value";
            var param = updateCmd.CreateParameter();
            param.ParameterName = "$key";
            param.Value = CounterKey;
            updateCmd.Parameters.Add(param);

            var result = await updateCmd.ExecuteScalarAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            if (result is string valueStr && int.TryParse(valueStr, out var num) && num >= 1)
            {
                return $"T{num}";
            }

            return "T1";
        }
        finally
        {
            // Do not close the connection; the scoped DbContext will use it for SaveChanges.
        }
    }
}
