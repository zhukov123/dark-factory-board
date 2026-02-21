import type { TicketDto } from './types'

export function computeEligibleIds(
  tickets: TicketDto[],
  blockersByTicket: Record<string, string[]>,
  activeLocks: Set<string>,
): Set<string> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const eligible = new Set<string>()

  for (const ticket of tickets) {
    if (ticket.status !== 'Ready') {
      continue
    }

    if (activeLocks.has(ticket.id)) {
      continue
    }

    const blockers = blockersByTicket[ticket.id] ?? []
    const allDone = blockers.every((blockerId) => byId.get(blockerId)?.status === 'Done')
    if (allDone) {
      eligible.add(ticket.id)
    }
  }

  return eligible
}

export function simulateDoneUnlocks(
  doneTicketId: string,
  tickets: TicketDto[],
  blockersByTicket: Record<string, string[]>,
): string[] {
  // Check which non-Done tickets have ALL blockers satisfied, ignoring Ready/Backlog status.
  // This tells you what becomes "unblocked and ready to queue" when doneTicketId is completed.
  const isAllBlockersDone = (ticketId: string, byId: Map<string, TicketDto>): boolean =>
    (blockersByTicket[ticketId] ?? []).every((b) => byId.get(b)?.status === 'Done')

  const beforeById = new Map(tickets.map((t) => [t.id, t]))
  const unlockedBefore = new Set(
    tickets
      .filter((t) => t.id !== doneTicketId && t.status !== 'Done')
      .filter((t) => isAllBlockersDone(t.id, beforeById))
      .map((t) => t.id),
  )

  const simulatedTickets = tickets.map((t) =>
    t.id === doneTicketId ? { ...t, status: 'Done' as const } : t,
  )
  const afterById = new Map(simulatedTickets.map((t) => [t.id, t]))
  const unlockedAfter = new Set(
    simulatedTickets
      .filter((t) => t.id !== doneTicketId && t.status !== 'Done')
      .filter((t) => isAllBlockersDone(t.id, afterById))
      .map((t) => t.id),
  )

  for (const ticketId of unlockedBefore) {
    unlockedAfter.delete(ticketId)
  }

  return Array.from(unlockedAfter).sort((left, right) => left.localeCompare(right))
}
