import {
  DndContext,
  type DragEndEvent,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  TaskBoardApiClient,
  type TicketPatchPayload,
  type TicketPayload,
} from './apiClient'
import { computeEligibleIds, simulateDoneUnlocks } from './scoring'
import { STATUSES, type TicketDto, type TicketStatus } from './types'
import './index.css'

const TOKEN_STORAGE_KEY = 'taskboard_token'
const BASE_URL_STORAGE_KEY = 'taskboard_api_base_url'

type TicketDraft = {
  title: string
  status: TicketStatus
  priority: number
  repo: string
  labelsText: string
  acceptanceText: string
  testPlan: string
  description: string
}

function App() {
  const queryClient = useQueryClient()
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem(BASE_URL_STORAGE_KEY) ?? '')
  const [authInvalid, setAuthInvalid] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)

  const [filters, setFilters] = useState({ status: '', repo: '', label: '', q: '' })

  const [createDraft, setCreateDraft] = useState<TicketDraft>({
    title: '',
    status: 'Backlog',
    priority: 0,
    repo: '',
    labelsText: '',
    acceptanceText: '',
    testPlan: '',
    description: '',
  })

  const [editDraft, setEditDraft] = useState<TicketDraft>({
    title: '',
    status: 'Backlog',
    priority: 0,
    repo: '',
    labelsText: '',
    acceptanceText: '',
    testPlan: '',
    description: '',
  })

  const [depsDraft, setDepsDraft] = useState<string[]>([])
  const [simulateTicketId, setSimulateTicketId] = useState('')

  const client = useMemo(
    () =>
      new TaskBoardApiClient({
        token,
        baseUrl,
        onUnauthorized: () => setAuthInvalid(true),
      }),
    [baseUrl, token],
  )

  const ticketsQuery = useQuery({
    queryKey: ['tickets', filters],
    queryFn: () =>
      client.getTickets({
        status: filters.status || undefined,
        repo: filters.repo || undefined,
        label: filters.label || undefined,
        q: filters.q || undefined,
      }),
    enabled: token.length > 0,
  })

  const tickets = ticketsQuery.data ?? []

  const depQueries = useQueries({
    queries: tickets.map((ticket) => ({
      queryKey: ['deps', ticket.id],
      queryFn: () => client.getDeps(ticket.id),
      enabled: token.length > 0,
    })),
  })

  const blockersByTicket = useMemo(() => {
    const map: Record<string, string[]> = {}
    tickets.forEach((ticket, index) => {
      const query = depQueries[index]
      map[ticket.id] = query?.data?.blocked_by ?? []
    })
    return map
  }, [depQueries, tickets])

  const activeLocks = useMemo(() => {
    const locks = new Set<string>()
    for (const ticket of tickets) {
      if (ticket.run?.lockOwner && ticket.run?.lockExpiresAt) {
        const expiresAt = Date.parse(ticket.run.lockExpiresAt)
        if (!Number.isNaN(expiresAt) && expiresAt > Date.now()) {
          locks.add(ticket.id)
        }
      }
    }
    return locks
  }, [tickets])

  const localEligible = useMemo(
    () => computeEligibleIds(tickets, blockersByTicket, activeLocks),
    [activeLocks, blockersByTicket, tickets],
  )

  const validateQuery = useQuery({
    queryKey: ['validate'],
    queryFn: () => client.validate(),
    enabled: token.length > 0,
    refetchInterval: 8000,
  })

  const eligibleQuery = useQuery({
    queryKey: ['eligible', filters.repo],
    queryFn: () => client.getEligible(filters.repo || undefined),
    enabled: token.length > 0,
    refetchInterval: 8000,
  })

  const pickNextQuery = useQuery({
    queryKey: ['pick-next', filters.repo],
    queryFn: () => client.pickNext(filters.repo || undefined),
    enabled: token.length > 0,
    refetchInterval: 8000,
  })

  const selectedTicket = useMemo(
    () => tickets.find((ticket) => ticket.id === selectedTicketId) ?? null,
    [selectedTicketId, tickets],
  )

  const selectedDepsQuery = useQuery({
    queryKey: ['deps', selectedTicketId],
    queryFn: () => client.getDeps(selectedTicketId as string),
    enabled: token.length > 0 && selectedTicketId !== null,
  })

  const eventsQuery = useQuery({
    queryKey: ['events', selectedTicketId],
    queryFn: () => client.getEvents(selectedTicketId as string),
    enabled: token.length > 0 && selectedTicketId !== null,
    refetchInterval: 8000,
  })

  const createMutation = useMutation({
    mutationFn: (payload: TicketPayload) => client.createTicket(payload),
    onSuccess: () => {
      setCreateDraft({
        title: '',
        status: 'Backlog',
        priority: 0,
        repo: '',
        labelsText: '',
        acceptanceText: '',
        testPlan: '',
        description: '',
      })
      void invalidateBoard(queryClient)
    },
    onError: (error) => setErrorMessage(formatError(error)),
  })

  const transitionMutation = useMutation({
    mutationFn: ({ ticketId, to }: { ticketId: string; to: string }) =>
      client.transitionTicket(ticketId, to),
    onSuccess: () => void invalidateBoard(queryClient),
    onError: (error) => setErrorMessage(formatError(error)),
  })

  const patchMutation = useMutation({
    mutationFn: ({ ticketId, payload }: { ticketId: string; payload: TicketPatchPayload }) =>
      client.patchTicket(ticketId, payload),
    onSuccess: () => void invalidateBoard(queryClient),
    onError: (error) => setErrorMessage(formatError(error)),
  })

  const depsMutation = useMutation({
    mutationFn: ({ ticketId, blockedBy }: { ticketId: string; blockedBy: string[] }) =>
      client.replaceDeps(ticketId, blockedBy),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['deps', variables.ticketId] })
      void queryClient.invalidateQueries({ queryKey: ['validate'] })
      void invalidateBoard(queryClient)
    },
    onError: (error) => setErrorMessage(formatError(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: (ticketId: string) => client.deleteTicket(ticketId),
    onSuccess: () => {
      setSelectedTicketId(null)
      void invalidateBoard(queryClient)
    },
    onError: (error) => setErrorMessage(formatError(error)),
  })

  useEffect(() => {
    if (!selectedTicket) {
      return
    }

    setEditDraft({
      title: selectedTicket.title,
      status: selectedTicket.status,
      priority: selectedTicket.priority,
      repo: selectedTicket.repo,
      labelsText: selectedTicket.labels.join(', '),
      acceptanceText: selectedTicket.acceptanceCriteria.join('\n'),
      testPlan: selectedTicket.testPlan ?? '',
      description: selectedTicket.description ?? '',
    })
  }, [selectedTicket])

  useEffect(() => {
    setDepsDraft(selectedDepsQuery.data?.blocked_by ?? [])
  }, [selectedDepsQuery.data])

  const cyclePath = validateQuery.data?.cycles?.[0] ?? []
  const cycleEdges = useMemo(() => {
    const edges = new Set<string>()
    for (let index = 0; index < cyclePath.length - 1; index += 1) {
      edges.add(`${cyclePath[index]}|${cyclePath[index + 1]}`)
    }
    return edges
  }, [cyclePath])

  const dependencyEdges = useMemo(
    () =>
      Object.entries(blockersByTicket).flatMap(([ticketId, blockers]) =>
        blockers.map((blockedById) => ({
          key: `${ticketId}|${blockedById}`,
          ticketId,
          blockedById,
          inCycle: cycleEdges.has(`${ticketId}|${blockedById}`),
        })),
      ),
    [blockersByTicket, cycleEdges],
  )

  const simulatedUnlocks = useMemo(() => {
    if (!simulateTicketId) {
      return []
    }
    return simulateDoneUnlocks(simulateTicketId, tickets, blockersByTicket)
  }, [blockersByTicket, simulateTicketId, tickets])

  const ticketsByStatus = useMemo(() => {
    const grouped = new Map<TicketStatus, TicketDto[]>()
    for (const status of STATUSES) {
      grouped.set(status, [])
    }

    for (const ticket of tickets) {
      const bucket = grouped.get(ticket.status)
      if (bucket) {
        bucket.push(ticket)
      }
    }

    return grouped
  }, [tickets])

  if (!token) {
    return (
      <TokenGate
        baseUrl={baseUrl}
        onSave={(nextToken, nextBaseUrl) => {
          localStorage.setItem(TOKEN_STORAGE_KEY, nextToken)
          localStorage.setItem(BASE_URL_STORAGE_KEY, nextBaseUrl)
          setToken(nextToken)
          setBaseUrl(nextBaseUrl)
          setAuthInvalid(false)
        }}
      />
    )
  }

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div className="toolbar-left">
          <h1>TaskBoard</h1>
          <span className="chip">Token set</span>
          <span className="chip">Base: {baseUrl || 'same origin'}</span>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(TOKEN_STORAGE_KEY)
              setToken('')
            }}
          >
            Reset Token
          </button>
        </div>
        <div className="toolbar-right">
          <button type="button" onClick={() => void invalidateBoard(queryClient)}>
            Refresh
          </button>
        </div>
      </header>

      {authInvalid && <div className="error-banner">401 from API. Check token or base URL.</div>}
      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <section className="panel">
        <h2>Filters</h2>
        <div className="grid grid-4">
          <label>
            Status
            <select
              value={filters.status}
              onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="">All</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repo
            <input
              value={filters.repo}
              onChange={(event) => setFilters((current) => ({ ...current, repo: event.target.value }))}
            />
          </label>
          <label>
            Label
            <input
              value={filters.label}
              onChange={(event) => setFilters((current) => ({ ...current, label: event.target.value }))}
            />
          </label>
          <label>
            Search
            <input
              value={filters.q}
              onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Create Ticket</h2>
        <div className="grid grid-4">
          <label>
            Title
            <input
              value={createDraft.title}
              onChange={(event) => setCreateDraft((current) => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label>
            Status
            <select
              value={createDraft.status}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, status: event.target.value as TicketStatus }))
              }
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <input
              type="number"
              value={createDraft.priority}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, priority: Number(event.target.value) }))
              }
            />
          </label>
          <label>
            Repo
            <input
              value={createDraft.repo}
              onChange={(event) => setCreateDraft((current) => ({ ...current, repo: event.target.value }))}
            />
          </label>
        </div>
        <div className="grid grid-2">
          <label>
            Labels (comma separated)
            <input
              value={createDraft.labelsText}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, labelsText: event.target.value }))
              }
            />
          </label>
          <label>
            Acceptance Criteria (one per line)
            <textarea
              value={createDraft.acceptanceText}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, acceptanceText: event.target.value }))
              }
            />
          </label>
          <label>
            Test Plan
            <textarea
              value={createDraft.testPlan}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, testPlan: event.target.value }))
              }
            />
          </label>
          <label>
            Description
            <textarea
              value={createDraft.description}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </label>
        </div>
        <button
          type="button"
          disabled={!createDraft.title.trim() || createMutation.isPending}
          onClick={() =>
            createMutation.mutate({
              title: createDraft.title.trim(),
              status: createDraft.status,
              priority: createDraft.priority,
              repo: createDraft.repo,
              labels: splitCsv(createDraft.labelsText),
              acceptanceCriteria: splitLines(createDraft.acceptanceText),
              testPlan: createDraft.testPlan,
              description: createDraft.description,
            })
          }
        >
          {createMutation.isPending ? 'Creating...' : 'Create Ticket'}
        </button>
      </section>

      <section className="panel">
        <h2>Kanban Board</h2>
        {ticketsQuery.isLoading && <div>Loading tickets...</div>}
        <DndContext
          onDragEnd={(event) => {
            handleDragEnd(event, tickets, transitionMutation)
          }}
        >
          <div className="kanban-grid">
            {STATUSES.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                tickets={ticketsByStatus.get(status) ?? []}
                onSelect={setSelectedTicketId}
              />
            ))}
          </div>
        </DndContext>
      </section>

      <section className="panel two-column">
        <div>
          <h2>Dependency Graph</h2>
          <div className="graph-status">{validateQuery.data?.ok === false ? 'Cycle detected' : 'DAG valid'}</div>
          {cyclePath.length > 0 && <div className="cycle-path">Cycle: {cyclePath.join(' -> ')}</div>}
          <ul className="edge-list">
            {dependencyEdges.map((edge) => (
              <li key={edge.key} className={edge.inCycle ? 'edge edge-cycle' : 'edge'}>
                {edge.ticketId} blocked by {edge.blockedById}
              </li>
            ))}
            {dependencyEdges.length === 0 && <li className="edge">No dependencies</li>}
          </ul>
        </div>
        <div>
          <h2>Orchestrator View</h2>
          <div className="pick-next">
            <strong>/pick-next</strong>
            {pickNextQuery.data?.ticketId ? (
              <div>
                <div>Ticket: {pickNextQuery.data.ticketId}</div>
                <div>Score: {pickNextQuery.data.score}</div>
                <div>Downstream unlock: {pickNextQuery.data.reasons?.downstreamUnblockedCount ?? 0}</div>
                <div>Critical depth: {pickNextQuery.data.reasons?.criticalPathDepth ?? 0}</div>
                <div>Priority: {pickNextQuery.data.reasons?.priority ?? 0}</div>
              </div>
            ) : (
              <div>{pickNextQuery.data?.reason ?? 'none eligible'}</div>
            )}
          </div>
          <div>
            <strong>/eligible</strong>
            <ul>
              {(eligibleQuery.data ?? []).map((ticket) => (
                <li key={ticket.ticketId}>
                  {ticket.ticketId} - {ticket.title}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <strong>Simulate Done</strong>
            <select value={simulateTicketId} onChange={(event) => setSimulateTicketId(event.target.value)}>
              <option value="">Select ticket</option>
              {tickets.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  {ticket.id}
                </option>
              ))}
            </select>
            <div>
              Newly eligible:{' '}
              {simulatedUnlocks.length > 0 ? simulatedUnlocks.join(', ') : 'none'}
            </div>
          </div>
          <div>
            Local eligible set: {Array.from(localEligible).join(', ') || 'none'}
          </div>
        </div>
      </section>

      {selectedTicket && (
        <section className="panel">
          <h2>Ticket Detail: {selectedTicket.id}</h2>
          <div className="grid grid-4">
            <label>
              Title
              <input
                value={editDraft.title}
                onChange={(event) => setEditDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </label>
            <label>
              Status
              <select
                value={editDraft.status}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, status: event.target.value as TicketStatus }))
                }
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <input
                type="number"
                value={editDraft.priority}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, priority: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              Repo
              <input
                value={editDraft.repo}
                onChange={(event) => setEditDraft((current) => ({ ...current, repo: event.target.value }))}
              />
            </label>
          </div>
          <div className="grid grid-2">
            <label>
              Labels (comma separated)
              <input
                value={editDraft.labelsText}
                onChange={(event) => setEditDraft((current) => ({ ...current, labelsText: event.target.value }))}
              />
            </label>
            <label>
              Acceptance Criteria
              <textarea
                value={editDraft.acceptanceText}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, acceptanceText: event.target.value }))
                }
              />
            </label>
            <label>
              Test Plan
              <textarea
                value={editDraft.testPlan}
                onChange={(event) => setEditDraft((current) => ({ ...current, testPlan: event.target.value }))}
              />
            </label>
            <label>
              Description
              <textarea
                value={editDraft.description}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
          </div>
          <div className="button-row">
            <button
              type="button"
              onClick={() =>
                patchMutation.mutate({
                  ticketId: selectedTicket.id,
                  payload: {
                    title: editDraft.title,
                    status: editDraft.status,
                    priority: editDraft.priority,
                    repo: editDraft.repo,
                    labels: splitCsv(editDraft.labelsText),
                    acceptanceCriteria: splitLines(editDraft.acceptanceText),
                    testPlan: editDraft.testPlan,
                    description: editDraft.description,
                  },
                })
              }
            >
              Save Ticket
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => deleteMutation.mutate(selectedTicket.id)}
            >
              Soft Delete
            </button>
          </div>

          <div className="grid grid-2">
            <div>
              <h3>Dependencies</h3>
              <label>
                Blocked by
                <select
                  multiple
                  value={depsDraft}
                  onChange={(event) => {
                    const next = Array.from(event.target.selectedOptions, (option) => option.value)
                    setDepsDraft(next)
                  }}
                >
                  {tickets
                    .filter((ticket) => ticket.id !== selectedTicket.id)
                    .map((ticket) => (
                      <option key={ticket.id} value={ticket.id}>
                        {ticket.id} - {ticket.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => depsMutation.mutate({ ticketId: selectedTicket.id, blockedBy: depsDraft })}
              >
                Save Dependencies
              </button>
              <div>Blocks: {(selectedDepsQuery.data?.blocks ?? []).join(', ') || 'none'}</div>
            </div>

            <div>
              <h3>Run State</h3>
              <ul>
                <li>Phase: {selectedTicket.run?.phase ?? 'n/a'}</li>
                <li>Attempt: {selectedTicket.run?.attempt ?? 0}</li>
                <li>Lock Owner: {selectedTicket.run?.lockOwner ?? 'none'}</li>
                <li>Lock Expires: {selectedTicket.run?.lockExpiresAt ?? 'none'}</li>
                <li>Branch: {selectedTicket.run?.branch ?? 'none'}</li>
                <li>PR: {selectedTicket.run?.prNumber ?? 'none'}</li>
                <li>CI: {selectedTicket.run?.lastCiState ?? 'unknown'}</li>
                <li>Summary: {selectedTicket.run?.lastSummary ?? 'none'}</li>
                <li>Error: {selectedTicket.run?.lastError ?? 'none'}</li>
              </ul>
            </div>
          </div>

          <div>
            <h3>Events</h3>
            <ul className="event-list">
              {(eventsQuery.data ?? []).map((event) => (
                <li key={event.id}>
                  <strong>{event.type}</strong> @ {new Date(event.createdAt).toLocaleString()} -{' '}
                  <code>{JSON.stringify(event.payload)}</code>
                </li>
              ))}
              {(eventsQuery.data ?? []).length === 0 && <li>No events</li>}
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}

function TokenGate({
  baseUrl,
  onSave,
}: {
  baseUrl: string
  onSave: (token: string, baseUrl: string) => void
}) {
  const [tokenInput, setTokenInput] = useState('')
  const [baseInput, setBaseInput] = useState(baseUrl)

  return (
    <div className="token-gate">
      <h1>TaskBoard Auth</h1>
      <p>Set the API bearer token and optional API base URL.</p>
      <label>
        Token
        <input value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} />
      </label>
      <label>
        API Base URL
        <input
          value={baseInput}
          placeholder="http://localhost:5005"
          onChange={(event) => setBaseInput(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!tokenInput.trim()}
        onClick={() => onSave(tokenInput.trim(), baseInput.trim())}
      >
        Save
      </button>
    </div>
  )
}

function KanbanColumn({
  status,
  tickets,
  onSelect,
}: {
  status: TicketStatus
  tickets: TicketDto[]
  onSelect: (ticketId: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })

  return (
    <div ref={setNodeRef} className={isOver ? 'kanban-column kanban-column-over' : 'kanban-column'}>
      <h3>
        {status} ({tickets.length})
      </h3>
      {tickets.map((ticket) => (
        <TicketCard key={ticket.id} ticket={ticket} onSelect={onSelect} />
      ))}
    </div>
  )
}

function TicketCard({ ticket, onSelect }: { ticket: TicketDto; onSelect: (ticketId: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    data: { status: ticket.status },
  })

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="ticket-card" {...listeners} {...attributes}>
      <button type="button" className="ticket-button" onClick={() => onSelect(ticket.id)}>
        <div className="ticket-title">
          {ticket.id}: {ticket.title}
        </div>
        <div className="ticket-meta">repo: {ticket.repo || 'none'}</div>
        <div className="ticket-meta">priority: {ticket.priority}</div>
        <div className="ticket-meta">labels: {ticket.labels.join(', ') || 'none'}</div>
        <div className="ticket-meta">blockers: {ticket.status === 'Ready' ? 'check deps' : '-'}</div>
        <div className="ticket-meta">
          lock: {ticket.run?.lockOwner ? `${ticket.run.lockOwner} until ${ticket.run.lockExpiresAt}` : 'none'}
        </div>
      </button>
    </div>
  )
}

function handleDragEnd(
  event: DragEndEvent,
  tickets: TicketDto[],
  transitionMutation: { mutate: (variables: { ticketId: string; to: string }) => void },
) {
  const over = event.over
  if (!over) {
    return
  }

  const ticketId = String(event.active.id)
  const targetStatus = String(over.id)
  const ticket = tickets.find((candidate) => candidate.id === ticketId)

  if (!ticket || ticket.status === targetStatus) {
    return
  }

  transitionMutation.mutate({ ticketId, to: targetStatus })
}

function splitCsv(input: string): string[] {
  return input
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function splitLines(input: string): string[] {
  return input
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}: ${JSON.stringify(error.payload)}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}

async function invalidateBoard(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['tickets'] }),
    queryClient.invalidateQueries({ queryKey: ['eligible'] }),
    queryClient.invalidateQueries({ queryKey: ['pick-next'] }),
    queryClient.invalidateQueries({ queryKey: ['validate'] }),
  ])
}

export default App
