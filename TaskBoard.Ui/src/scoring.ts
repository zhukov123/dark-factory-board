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
  const locks = new Set<string>()
  const baseline = computeEligibleIds(tickets, blockersByTicket, locks)
  const simulatedTickets = tickets.map((ticket) =>
    ticket.id === doneTicketId ? { ...ticket, status: 'Done' as const } : ticket,
  )
  const after = computeEligibleIds(simulatedTickets, blockersByTicket, locks)

  for (const ticketId of baseline) {
    after.delete(ticketId)
  }

  after.delete(doneTicketId)
  return Array.from(after).sort((left, right) => left.localeCompare(right))
}
