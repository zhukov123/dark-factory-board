using TaskBoard.Api.Data;
using TaskBoard.Api.Domain;

namespace TaskBoard.Api.Services;

public sealed class DagService
{
    public bool TryFindCycle(
        IEnumerable<string> nodes,
        IReadOnlyDictionary<string, List<string>> blockersByTicket,
        out List<string> cyclePath)
    {
        var color = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var stack = new List<string>();
        var stackIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        cyclePath = [];

        foreach (var node in nodes)
        {
            if (color.GetValueOrDefault(node) != 0)
            {
                continue;
            }

            if (Visit(node, blockersByTicket, color, stack, stackIndex, out cyclePath))
            {
                return true;
            }
        }

        return false;
    }

    public bool WouldIntroduceCycle(
        IEnumerable<string> nodes,
        IReadOnlyDictionary<string, List<string>> blockersByTicket,
        string ticketId,
        IEnumerable<string> replacementBlockedBy,
        out List<string> cyclePath)
    {
        var mutated = blockersByTicket.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.ToList(), StringComparer.OrdinalIgnoreCase);
        mutated[ticketId] = replacementBlockedBy.Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        foreach (var node in nodes)
        {
            _ = mutated.TryAdd(node, []);
        }

        return TryFindCycle(nodes, mutated, out cyclePath);
    }

    public IReadOnlyDictionary<string, List<string>> BuildBlockersByTicket(
        IEnumerable<string> ticketIds,
        IEnumerable<DependencyEntity> dependencies)
    {
        var map = ticketIds.ToDictionary(id => id, _ => new List<string>(), StringComparer.OrdinalIgnoreCase);
        foreach (var dependency in dependencies)
        {
            if (map.ContainsKey(dependency.TicketId) && map.ContainsKey(dependency.BlockedById))
            {
                map[dependency.TicketId].Add(dependency.BlockedById);
            }
        }

        return map;
    }

    public IReadOnlyDictionary<string, List<string>> BuildDownstreamByTicket(
        IEnumerable<string> ticketIds,
        IEnumerable<DependencyEntity> dependencies)
    {
        var map = ticketIds.ToDictionary(id => id, _ => new List<string>(), StringComparer.OrdinalIgnoreCase);
        foreach (var dependency in dependencies)
        {
            if (map.ContainsKey(dependency.TicketId) && map.ContainsKey(dependency.BlockedById))
            {
                map[dependency.BlockedById].Add(dependency.TicketId);
            }
        }

        return map;
    }

    public HashSet<string> ComputeEligibleIds(
        IEnumerable<TicketEntity> tickets,
        IReadOnlyDictionary<string, List<string>> blockersByTicket,
        ISet<string> activeLocks)
    {
        var ticketById = tickets.ToDictionary(t => t.Id, StringComparer.OrdinalIgnoreCase);
        var eligible = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var ticket in tickets)
        {
            if (ticket.Status != TicketStatus.Ready)
            {
                continue;
            }

            if (activeLocks.Contains(ticket.Id))
            {
                continue;
            }

            var blockers = blockersByTicket.GetValueOrDefault(ticket.Id) ?? [];
            var allDone = blockers.All(blockerId =>
                ticketById.TryGetValue(blockerId, out var blocker) && blocker.Status == TicketStatus.Done);

            if (allDone)
            {
                eligible.Add(ticket.Id);
            }
        }

        return eligible;
    }

    public int ComputeCriticalPathDepth(
        string ticketId,
        IReadOnlyDictionary<string, List<string>> downstreamByTicket)
    {
        var memo = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        return ComputeDepth(ticketId, downstreamByTicket, memo, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
    }

    public int ComputeDownstreamUnblockedSimulationCount(
        string ticketId,
        IReadOnlyList<TicketEntity> tickets,
        IReadOnlyDictionary<string, List<string>> blockersByTicket,
        ISet<string> activeLocks)
    {
        var baselineEligible = ComputeEligibleIds(tickets, blockersByTicket, activeLocks);

        var simulated = tickets
            .Select(t => new TicketEntity
            {
                Id = t.Id,
                Status = t.Id.Equals(ticketId, StringComparison.OrdinalIgnoreCase) ? TicketStatus.Done : t.Status
            })
            .ToList();

        var simulatedEligible = ComputeEligibleIds(simulated, blockersByTicket, activeLocks);

        simulatedEligible.ExceptWith(baselineEligible);
        simulatedEligible.Remove(ticketId);

        return simulatedEligible.Count;
    }

    private static bool Visit(
        string node,
        IReadOnlyDictionary<string, List<string>> blockersByTicket,
        IDictionary<string, int> color,
        IList<string> stack,
        IDictionary<string, int> stackIndex,
        out List<string> cyclePath)
    {
        color[node] = 1;
        stackIndex[node] = stack.Count;
        stack.Add(node);

        foreach (var blocker in blockersByTicket.GetValueOrDefault(node) ?? [])
        {
            var blockerColor = color.TryGetValue(blocker, out var value) ? value : 0;

            if (blockerColor == 0)
            {
                if (Visit(blocker, blockersByTicket, color, stack, stackIndex, out cyclePath))
                {
                    return true;
                }
            }
            else if (blockerColor == 1 && stackIndex.TryGetValue(blocker, out var startIndex))
            {
                cyclePath = stack.Skip(startIndex).ToList();
                cyclePath.Add(blocker);
                return true;
            }
        }

        color[node] = 2;
        stackIndex.Remove(node);
        stack.RemoveAt(stack.Count - 1);
        cyclePath = [];
        return false;
    }

    private static int ComputeDepth(
        string ticketId,
        IReadOnlyDictionary<string, List<string>> downstreamByTicket,
        IDictionary<string, int> memo,
        ISet<string> activePath)
    {
        if (memo.TryGetValue(ticketId, out var cached))
        {
            return cached;
        }

        if (!activePath.Add(ticketId))
        {
            return 0;
        }

        var children = downstreamByTicket.GetValueOrDefault(ticketId) ?? [];
        var maxChildDepth = 0;

        foreach (var child in children)
        {
            var childDepth = 1 + ComputeDepth(child, downstreamByTicket, memo, activePath);
            if (childDepth > maxChildDepth)
            {
                maxChildDepth = childDepth;
            }
        }

        activePath.Remove(ticketId);
        memo[ticketId] = maxChildDepth;
        return maxChildDepth;
    }
}
