import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { type CSSProperties } from 'react'
import type { TicketDto, TicketStatus } from '../types'

const STATUS_COLORS: Record<TicketStatus, string> = {
  Backlog: '#8c99a6',
  Ready: '#1a6fba',
  InProgress: '#c97d10',
  Review: '#6b4eb8',
  Done: '#1a7a4a',
  Blocked: '#a72323',
}

export function KanbanColumn({
  status,
  tickets,
  blockersByTicket,
  eligibleIds,
  lockedIds,
  onSelect,
}: {
  status: TicketStatus
  tickets: TicketDto[]
  blockersByTicket: Record<string, string[]>
  eligibleIds: Set<string>
  lockedIds: Set<string>
  onSelect: (ticketId: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const accentColor = STATUS_COLORS[status]

  return (
    <div
      ref={setNodeRef}
      className={isOver ? 'kanban-column kanban-column-over' : 'kanban-column'}
      style={{ '--column-accent': accentColor } as CSSProperties}
    >
      <h3 className="column-header">
        <span className="column-status-dot" />
        {status}
        <span className="column-count">{tickets.length}</span>
      </h3>
      {tickets.map((ticket) => (
        <TicketCard
          key={ticket.id}
          ticket={ticket}
          blockers={blockersByTicket[ticket.id] ?? []}
          isEligible={eligibleIds.has(ticket.id)}
          isLocked={lockedIds.has(ticket.id)}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function TicketCard({
  ticket,
  blockers,
  isEligible,
  isLocked,
  onSelect,
}: {
  ticket: TicketDto
  blockers: string[]
  isEligible: boolean
  isLocked: boolean
  onSelect: (ticketId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    data: { status: ticket.status },
  })

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  }

  let cardStateClass = ''
  if (isLocked) cardStateClass = 'ticket-card-locked'
  else if (isEligible) cardStateClass = 'ticket-card-eligible'
  else if (blockers.length > 0) cardStateClass = 'ticket-card-blocked'

  const priorityNum = ticket.priority
  const priorityLabel = `P${priorityNum}`
  const priorityClass =
    priorityNum <= 0
      ? 'priority-badge priority-p0'
      : priorityNum === 1
        ? 'priority-badge priority-p1'
        : 'priority-badge priority-p2'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`ticket-card ${cardStateClass}`}
      {...listeners}
      {...attributes}
    >
      <button type="button" className="ticket-button" onClick={() => onSelect(ticket.id)}>
        <div className="ticket-top-row">
          <span className="ticket-id">{ticket.id}</span>
          <div className="ticket-badges">
            <span className={priorityClass}>{priorityLabel}</span>
            {isLocked && (
              <span className="lock-badge" title="Locked by orchestrator">
                🔒
              </span>
            )}
            {isEligible && !isLocked && (
              <span className="eligible-dot" title="Eligible to run" />
            )}
          </div>
        </div>
        <div className="ticket-title">{ticket.title}</div>
        {ticket.repo && <div className="ticket-repo">{ticket.repo}</div>}
        {ticket.labels.length > 0 && (
          <div className="ticket-labels">
            {ticket.labels.map((lbl) => (
              <span key={lbl} className="ticket-label-chip">
                {lbl}
              </span>
            ))}
          </div>
        )}
        {blockers.length > 0 && (
          <div className="ticket-blockers">
            ⛔ {blockers.length} blocker{blockers.length !== 1 ? 's' : ''}
          </div>
        )}
      </button>
    </div>
  )
}
