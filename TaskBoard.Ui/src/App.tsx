import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { TaskBoardApiClient, type TicketPayload } from './apiClient'
import { KanbanColumn } from './components/KanbanColumn'
import { TicketModal } from './components/TicketModal'
import { TokenGate } from './components/TokenGate'
import { computeEligibleIds, simulateDoneUnlocks } from './scoring'
import { STATUSES, type TicketDto, type TicketDraft, type TicketStatus } from './types'
import { formatError, invalidateBoard, splitCsv, splitLines } from './utils'
import './index.css'

const TOKEN_STORAGE_KEY = 'taskboard_token'
const BASE_URL_STORAGE_KEY = 'taskboard_api_base_url'

const EMPTY_DRAFT: TicketDraft = {
  title: '',
  status: 'Backlog',
  priority: 0,
  repo: '',
  labelsText: '',
  acceptanceText: '',
  testPlan: '',
  description: '',
}

function App() {
  const queryClient = useQueryClient()
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem(BASE_URL_STORAGE_KEY) ?? '')
  const [authInvalid, setAuthInvalid] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [filters, setFilters] = useState({ status: '', repo: '', label: '', q: '' })
  const [createDraft, setCreateDraft] = useState<TicketDraft>(EMPTY_DRAFT)
  const [simulateTicketId, setSimulateTicketId] = useState('')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)

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
        limit: 200,
        offset: 0,
      }),
    enabled: token.length > 0,
  })

  const tickets = ticketsQuery.data?.items ?? []

  const depsBatchQuery = useQuery({
    queryKey: ['deps-batch', tickets.map((t) => t.id).sort().join(',')],
    queryFn: () => client.getDepsBatch(tickets.map((t) => t.id)),
    enabled: token.length > 0 && tickets.length > 0,
  })

  const blockersByTicket = useMemo(() => {
    const map: Record<string, string[]> = {}
    const batch = depsBatchQuery.data
    if (!batch) {
      tickets.forEach((t) => {
        map[t.id] = []
      })
      return map
    }
    tickets.forEach((ticket) => {
      map[ticket.id] = batch[ticket.id]?.blocked_by ?? []
    })
    return map
  }, [depsBatchQuery.data, tickets])

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

  const createMutation = useMutation({
    mutationFn: (payload: TicketPayload) => client.createTicket(payload),
    onSuccess: () => {
      setCreateDraft(EMPTY_DRAFT)
      setIsCreateModalOpen(false)
      setErrorMessage('')
      void invalidateBoard(queryClient)
    },
    onError: (error) => setErrorMessage(formatError(error)),
  })

  const transitionMutation = useMutation({
    mutationFn: ({ ticketId, to }: { ticketId: string; to: string }) =>
      client.transitionTicket(ticketId, to),
    onSuccess: () => {
      setErrorMessage('')
      void invalidateBoard(queryClient)
    },
    onError: (error) => setErrorMessage(formatError(error)),
  })

  const simulatedUnlocks = useMemo(() => {
    if (!simulateTicketId) return []
    return simulateDoneUnlocks(simulateTicketId, tickets, blockersByTicket)
  }, [blockersByTicket, simulateTicketId, tickets])

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

  const ticketsByStatus = useMemo(() => {
    const grouped = new Map<TicketStatus, TicketDto[]>()
    for (const status of STATUSES) {
      grouped.set(status, [])
    }
    for (const ticket of tickets) {
      const bucket = grouped.get(ticket.status)
      if (bucket) bucket.push(ticket)
    }
    return grouped
  }, [tickets])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const openTicketDetails = (ticketId: string) => {
    setSelectedTicketId(ticketId)
  }

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
          <span className="chip">{baseUrl || 'same origin'}</span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              localStorage.removeItem(TOKEN_STORAGE_KEY)
              setToken('')
            }}
          >
            Sign out
          </button>
        </div>
        <div className="toolbar-right">
          <button type="button" onClick={() => setIsCreateModalOpen(true)}>
            + New Ticket
          </button>
          <button type="button" className="secondary" onClick={() => void invalidateBoard(queryClient)}>
            Refresh
          </button>
        </div>
      </header>

      {authInvalid && (
        <div className="error-banner">
          <span>401 — Check your token or base URL.</span>
          <button type="button" className="banner-dismiss" onClick={() => setAuthInvalid(false)}>
            ×
          </button>
        </div>
      )}
      {errorMessage && (
        <div className="error-banner">
          <span>{errorMessage}</span>
          <button type="button" className="banner-dismiss" onClick={() => setErrorMessage('')}>
            ×
          </button>
        </div>
      )}

      <section className="panel filter-panel">
        <div className="filter-bar">
          <select
            value={filters.status}
            onChange={(e) => setFilters((c) => ({ ...c, status: e.target.value }))}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            placeholder="Repo"
            value={filters.repo}
            onChange={(e) => setFilters((c) => ({ ...c, repo: e.target.value }))}
          />
          <input
            placeholder="Label"
            value={filters.label}
            onChange={(e) => setFilters((c) => ({ ...c, label: e.target.value }))}
          />
          <input
            placeholder="Search titles…"
            value={filters.q}
            onChange={(e) => setFilters((c) => ({ ...c, q: e.target.value }))}
          />
        </div>
      </section>

      {/* ── Create modal ─────────────────────────────────────── */}
      {isCreateModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!createMutation.isPending) setIsCreateModalOpen(false)
          }}
        >
          <section className="panel modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Ticket</h2>
              <button
                type="button"
                className="secondary"
                disabled={createMutation.isPending}
                onClick={() => setIsCreateModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="grid grid-4">
              <label>
                Title
                <input
                  autoFocus
                  value={createDraft.title}
                  onChange={(e) => setCreateDraft((c) => ({ ...c, title: e.target.value }))}
                />
              </label>
              <label>
                Status
                <select
                  value={createDraft.status}
                  onChange={(e) =>
                    setCreateDraft((c) => ({ ...c, status: e.target.value as TicketStatus }))
                  }
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Priority
                <input
                  type="number"
                  value={createDraft.priority}
                  onChange={(e) =>
                    setCreateDraft((c) => ({ ...c, priority: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                Repo
                <input
                  value={createDraft.repo}
                  onChange={(e) => setCreateDraft((c) => ({ ...c, repo: e.target.value }))}
                />
              </label>
            </div>
            <div className="grid grid-2">
              <label>
                Labels <span className="field-hint">(comma separated)</span>
                <input
                  value={createDraft.labelsText}
                  onChange={(e) => setCreateDraft((c) => ({ ...c, labelsText: e.target.value }))}
                />
              </label>
              <label>
                Acceptance Criteria <span className="field-hint">(one per line)</span>
                <textarea
                  value={createDraft.acceptanceText}
                  onChange={(e) =>
                    setCreateDraft((c) => ({ ...c, acceptanceText: e.target.value }))
                  }
                />
              </label>
              <label>
                Test Plan
                <textarea
                  value={createDraft.testPlan}
                  onChange={(e) => setCreateDraft((c) => ({ ...c, testPlan: e.target.value }))}
                />
              </label>
              <label>
                Description
                <textarea
                  value={createDraft.description}
                  onChange={(e) =>
                    setCreateDraft((c) => ({ ...c, description: e.target.value }))
                  }
                />
              </label>
            </div>
            <div className="button-row">
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
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={createMutation.isPending}
                onClick={() => setIsCreateModalOpen(false)}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── Ticket detail modal ───────────────────────────────── */}
      {selectedTicket && (
        <TicketModal
          ticket={selectedTicket}
          tickets={tickets}
          client={client}
          queryClient={queryClient}
          onClose={() => setSelectedTicketId(null)}
          onError={setErrorMessage}
          onDeleted={() => {
            setSelectedTicketId(null)
            setErrorMessage('')
            void invalidateBoard(queryClient)
          }}
        />
      )}

      {/* ── Kanban board ─────────────────────────────────────── */}
      <section className="panel">
        <h2>Board</h2>
        {ticketsQuery.isLoading && <div className="loading-hint">Loading…</div>}
        <DndContext sensors={sensors} onDragEnd={(event) => handleDragEnd(event, tickets, transitionMutation)}>
          <div className="kanban-grid">
            {STATUSES.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                tickets={ticketsByStatus.get(status) ?? []}
                blockersByTicket={blockersByTicket}
                eligibleIds={localEligible}
                lockedIds={activeLocks}
                onSelect={openTicketDetails}
              />
            ))}
          </div>
        </DndContext>
      </section>

      {/* ── Insights panel ───────────────────────────────────── */}
      <section className="panel insights-panel">
        <h2>Insights</h2>
        <div className="insights-grid">

          {/* Column 1: Dependency Graph */}
          <div className="insights-col">
            <div className="insights-col-label">Dependency Graph</div>
            <div
              className={`graph-status ${
                validateQuery.data?.ok === false ? 'graph-status-error' : 'graph-status-ok'
              }`}
            >
              {validateQuery.data?.ok === false ? '⚠ Cycle detected' : '✓ DAG valid'}
            </div>
            {cyclePath.length > 0 && (
              <div className="cycle-path">Cycle: {cyclePath.join(' → ')}</div>
            )}
            <ul className="edge-list">
              {dependencyEdges.map((edge) => (
                <li key={edge.key} className={edge.inCycle ? 'edge edge-cycle' : 'edge'}>
                  <span className="edge-ticket">{edge.ticketId}</span>
                  <span className="edge-arrow"> ← </span>
                  <span className="edge-ticket">{edge.blockedById}</span>
                </li>
              ))}
              {dependencyEdges.length === 0 && (
                <li className="edge edge-empty">No dependencies defined</li>
              )}
            </ul>
          </div>

          {/* Column 2: Orchestrator */}
          <div className="insights-col">
            <div className="insights-col-label">Orchestrator</div>
            <div className="orchestrator-section">
              <div className="section-label">Pick Next</div>
              {pickNextQuery.data?.ticketId ? (
                <div className="pick-next-card">
                  <div className="pick-next-top">
                    <button
                      type="button"
                      className="pick-next-id"
                      onClick={() => openTicketDetails(pickNextQuery.data!.ticketId!)}
                    >
                      {pickNextQuery.data.ticketId}
                    </button>
                    <span className="score-pill">score {pickNextQuery.data.score}</span>
                  </div>
                  <div className="pick-next-reasons">
                    <span>↓ {pickNextQuery.data.reasons?.downstreamUnblockedCount ?? 0} downstream</span>
                    <span>⬤ depth {pickNextQuery.data.reasons?.criticalPathDepth ?? 0}</span>
                    <span>P{pickNextQuery.data.reasons?.priority ?? 0}</span>
                  </div>
                </div>
              ) : (
                <div className="pick-next-empty">
                  {pickNextQuery.data?.reason ?? 'No eligible tickets'}
                </div>
              )}
            </div>
            <div className="orchestrator-section">
              <div className="section-label">
                Eligible ({eligibleQuery.data?.length ?? 0})
              </div>
              <ul className="eligible-list">
                {(eligibleQuery.data ?? []).map((ticket) => (
                  <li key={ticket.ticketId}>
                    <button
                      type="button"
                      className="eligible-item"
                      onClick={() => openTicketDetails(ticket.ticketId)}
                    >
                      <span className="eligible-id">{ticket.ticketId}</span>
                      <span className="eligible-title">{ticket.title}</span>
                      {ticket.repo && <span className="eligible-repo">{ticket.repo}</span>}
                    </button>
                  </li>
                ))}
                {(eligibleQuery.data ?? []).length === 0 && (
                  <li className="eligible-empty">None</li>
                )}
              </ul>
            </div>
          </div>

          {/* Column 3: Simulate */}
          <div className="insights-col">
            <div className="insights-col-label">Simulate</div>
            <div className="orchestrator-section">
              <div className="section-label">Mark as Done</div>
              <select
                className="simulate-select"
                value={simulateTicketId}
                onChange={(e) => setSimulateTicketId(e.target.value)}
              >
                <option value="">Select a ticket…</option>
                {tickets.map((ticket) => (
                  <option key={ticket.id} value={ticket.id}>
                    {ticket.id} — {ticket.title}
                  </option>
                ))}
              </select>
              <div className="simulate-result">
                Newly eligible:{' '}
                {simulatedUnlocks.length > 0
                  ? simulatedUnlocks.join(', ')
                  : simulateTicketId
                    ? 'none'
                    : '—'}
              </div>
            </div>
            <div className="orchestrator-section">
              <div className="section-label">Local eligible</div>
              <div className="local-eligible">
                {Array.from(localEligible).length > 0 ? (
                  Array.from(localEligible).map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="eligible-chip"
                      onClick={() => openTicketDetails(id)}
                    >
                      {id}
                    </button>
                  ))
                ) : (
                  <span className="eligible-empty">none</span>
                )}
              </div>
            </div>
          </div>

        </div>
      </section>
    </div>
  )
}

function handleDragEnd(
  event: DragEndEvent,
  tickets: TicketDto[],
  transitionMutation: { mutate: (variables: { ticketId: string; to: string }) => void },
) {
  const over = event.over
  if (!over) return

  const ticketId = String(event.active.id)
  const targetStatus = String(over.id)
  const ticket = tickets.find((candidate) => candidate.id === ticketId)

  if (!ticket || ticket.status === targetStatus) return

  transitionMutation.mutate({ ticketId, to: targetStatus })
}

export default App
