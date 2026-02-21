import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
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

const STATUS_COLORS: Record<TicketStatus, string> = {
  Backlog: '#8c99a6',
  Ready: '#1a6fba',
  InProgress: '#c97d10',
  Review: '#6b4eb8',
  Done: '#1a7a4a',
  Blocked: '#a72323',
}

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

// ── Ticket Modal ───────────────────────────────────────────────────────────────

function TicketModal({
  ticket,
  tickets,
  client,
  queryClient,
  onClose,
  onError,
  onDeleted,
}: {
  ticket: TicketDto
  tickets: TicketDto[]
  client: TaskBoardApiClient
  queryClient: ReturnType<typeof useQueryClient>
  onClose: () => void
  onError: (msg: string) => void
  onDeleted: () => void
}) {
  const [editDraft, setEditDraft] = useState<TicketDraft>({
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    repo: ticket.repo,
    labelsText: ticket.labels.join(', '),
    acceptanceText: ticket.acceptanceCriteria.join('\n'),
    testPlan: ticket.testPlan ?? '',
    description: ticket.description ?? '',
  })
  const [depsDraft, setDepsDraft] = useState<string[]>([])
  const backdropRef = useRef<HTMLDivElement>(null)

  const selectedDepsQuery = useQuery({
    queryKey: ['deps', ticket.id],
    queryFn: () => client.getDeps(ticket.id),
  })

  const eventsQuery = useQuery({
    queryKey: ['events', ticket.id],
    queryFn: () => client.getEvents(ticket.id),
    refetchInterval: 8000,
  })

  useEffect(() => {
    setDepsDraft(selectedDepsQuery.data?.blocked_by ?? [])
  }, [selectedDepsQuery.data])

  // Sync draft if ticket changes externally (e.g. after save)
  useEffect(() => {
    setEditDraft({
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      repo: ticket.repo,
      labelsText: ticket.labels.join(', '),
      acceptanceText: ticket.acceptanceCriteria.join('\n'),
      testPlan: ticket.testPlan ?? '',
      description: ticket.description ?? '',
    })
  }, [ticket])

  // Escape key closes modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const patchMutation = useMutation({
    mutationFn: (payload: TicketPatchPayload) => client.patchTicket(ticket.id, payload),
    onSuccess: () => {
      onError('')
      void invalidateBoard(queryClient)
      void queryClient.invalidateQueries({ queryKey: ['events', ticket.id] })
    },
    onError: (error) => onError(formatError(error)),
  })

  const depsMutation = useMutation({
    mutationFn: (blockedBy: string[]) => client.replaceDeps(ticket.id, blockedBy),
    onSuccess: () => {
      onError('')
      void queryClient.invalidateQueries({ queryKey: ['deps', ticket.id] })
      void queryClient.invalidateQueries({ queryKey: ['validate'] })
      void invalidateBoard(queryClient)
    },
    onError: (error) => onError(formatError(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: () => client.deleteTicket(ticket.id),
    onSuccess: onDeleted,
    onError: (error) => onError(formatError(error)),
  })

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose()
      }}
    >
      <div className="ticket-modal">
        {/* Header */}
        <div className="ticket-modal-header">
          <div className="ticket-modal-title">
            <span className="ticket-modal-id">{ticket.id}</span>
            <span className="ticket-modal-sep">—</span>
            <span className="ticket-modal-name">{ticket.title}</span>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="ticket-modal-body">
          {/* Left column: edit form */}
          <div className="ticket-modal-left">
            <div className="modal-section-label">Details</div>
            <div className="grid grid-2">
              <label>
                Title
                <input
                  value={editDraft.title}
                  onChange={(e) => setEditDraft((c) => ({ ...c, title: e.target.value }))}
                />
              </label>
              <label>
                Repo
                <input
                  value={editDraft.repo}
                  onChange={(e) => setEditDraft((c) => ({ ...c, repo: e.target.value }))}
                />
              </label>
              <label>
                Status
                <select
                  value={editDraft.status}
                  onChange={(e) =>
                    setEditDraft((c) => ({ ...c, status: e.target.value as TicketStatus }))
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
                  value={editDraft.priority}
                  onChange={(e) =>
                    setEditDraft((c) => ({ ...c, priority: Number(e.target.value) }))
                  }
                />
              </label>
            </div>
            <label>
              Labels <span className="field-hint">(comma separated)</span>
              <input
                value={editDraft.labelsText}
                onChange={(e) => setEditDraft((c) => ({ ...c, labelsText: e.target.value }))}
              />
            </label>
            <label>
              Description
              <textarea
                rows={3}
                value={editDraft.description}
                onChange={(e) => setEditDraft((c) => ({ ...c, description: e.target.value }))}
              />
            </label>
            <label>
              Acceptance Criteria <span className="field-hint">(one per line)</span>
              <textarea
                rows={4}
                value={editDraft.acceptanceText}
                onChange={(e) => setEditDraft((c) => ({ ...c, acceptanceText: e.target.value }))}
              />
            </label>
            <label>
              Test Plan
              <textarea
                rows={3}
                value={editDraft.testPlan}
                onChange={(e) => setEditDraft((c) => ({ ...c, testPlan: e.target.value }))}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                disabled={patchMutation.isPending}
                onClick={() =>
                  patchMutation.mutate({
                    title: editDraft.title,
                    status: editDraft.status,
                    priority: editDraft.priority,
                    repo: editDraft.repo,
                    labels: splitCsv(editDraft.labelsText),
                    acceptanceCriteria: splitLines(editDraft.acceptanceText),
                    testPlan: editDraft.testPlan,
                    description: editDraft.description,
                  })
                }
              >
                {patchMutation.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="danger"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (window.confirm(`Delete ${ticket.id}? This cannot be undone.`)) {
                    deleteMutation.mutate()
                  }
                }}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>

          {/* Right column: deps, run state, events */}
          <div className="ticket-modal-right">
            {/* Dependencies */}
            <div className="modal-section-label">Dependencies</div>
            <div className="dep-picker">
              <div className="dep-chips">
                {depsDraft.length === 0 ? (
                  <span className="dep-empty">No blockers selected</span>
                ) : (
                  depsDraft.map((id) => {
                    const t = tickets.find((tk) => tk.id === id)
                    return (
                      <span key={id} className="dep-chip">
                        <span className="dep-chip-label">
                          {id}
                          {t ? ` — ${t.title}` : ''}
                        </span>
                        <button
                          type="button"
                          className="dep-chip-remove"
                          onClick={() => setDepsDraft((c) => c.filter((d) => d !== id))}
                        >
                          ×
                        </button>
                      </span>
                    )
                  })
                )}
              </div>
              <div className="dep-list">
                {tickets
                  .filter((t) => t.id !== ticket.id)
                  .map((t) => (
                    <label key={t.id} className="dep-item">
                      <input
                        type="checkbox"
                        checked={depsDraft.includes(t.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setDepsDraft((c) => [...c, t.id])
                          } else {
                            setDepsDraft((c) => c.filter((d) => d !== t.id))
                          }
                        }}
                      />
                      <span className="dep-item-id">{t.id}</span>
                      <span className="dep-item-title">{t.title}</span>
                    </label>
                  ))}
              </div>
              <button
                type="button"
                disabled={depsMutation.isPending}
                onClick={() => depsMutation.mutate(depsDraft)}
              >
                {depsMutation.isPending ? 'Saving…' : 'Save Dependencies'}
              </button>
            </div>
            {(selectedDepsQuery.data?.blocks ?? []).length > 0 && (
              <div className="blocks-row">
                <span className="blocks-label">Blocks:</span>
                <span>{(selectedDepsQuery.data?.blocks ?? []).join(', ')}</span>
              </div>
            )}

            {/* Run State */}
            <div className="modal-section-label" style={{ marginTop: '1rem' }}>Run State</div>
            <dl className="run-state-dl">
              <dt>Phase</dt>
              <dd>{ticket.run?.phase ?? 'n/a'}</dd>
              <dt>Attempt</dt>
              <dd>{ticket.run?.attempt ?? 0}</dd>
              {ticket.run?.lockOwner && (
                <>
                  <dt>Lock Owner</dt>
                  <dd>{ticket.run.lockOwner}</dd>
                </>
              )}
              {ticket.run?.lockExpiresAt && (
                <>
                  <dt>Expires</dt>
                  <dd>{new Date(ticket.run.lockExpiresAt).toLocaleString()}</dd>
                </>
              )}
              {ticket.run?.branch && (
                <>
                  <dt>Branch</dt>
                  <dd>
                    <code>{ticket.run.branch}</code>
                  </dd>
                </>
              )}
              {ticket.run?.prNumber != null && (
                <>
                  <dt>PR</dt>
                  <dd>#{ticket.run.prNumber}</dd>
                </>
              )}
              <dt>CI</dt>
              <dd>{ticket.run?.lastCiState ?? 'unknown'}</dd>
              {ticket.run?.lastSummary && (
                <>
                  <dt>Summary</dt>
                  <dd>{ticket.run.lastSummary}</dd>
                </>
              )}
              {ticket.run?.lastError && (
                <>
                  <dt>Error</dt>
                  <dd className="run-error">{ticket.run.lastError}</dd>
                </>
              )}
            </dl>

            {/* Events */}
            <div className="modal-section-label" style={{ marginTop: '1rem' }}>Events</div>
            <ul className="event-list">
              {(eventsQuery.data ?? []).map((event) => (
                <li key={event.id} className="event-item">
                  <div className="event-header">
                    <span className="event-type">{event.type}</span>
                    <span className="event-time">
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {event.payload != null &&
                  typeof event.payload === 'object' &&
                  Object.keys(event.payload as object).length > 0 ? (
                    <details className="event-payload">
                      <summary>payload</summary>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
              {(eventsQuery.data ?? []).length === 0 && (
                <li className="event-empty">No events yet</li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Token Gate ─────────────────────────────────────────────────────────────────

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
      <h1>TaskBoard</h1>
      <p>Enter your API bearer token to connect.</p>
      <label>
        Token
        <input
          type="password"
          autoFocus
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tokenInput.trim()) {
              onSave(tokenInput.trim(), baseInput.trim())
            }
          }}
        />
      </label>
      <label>
        API Base URL <span className="field-hint">(optional)</span>
        <input
          value={baseInput}
          placeholder="http://localhost:5005"
          onChange={(e) => setBaseInput(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!tokenInput.trim()}
        onClick={() => onSave(tokenInput.trim(), baseInput.trim())}
      >
        Connect
      </button>
    </div>
  )
}

// ── Kanban Column ──────────────────────────────────────────────────────────────

function KanbanColumn({
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

// ── Ticket Card ────────────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function splitCsv(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

function splitLines(input: string): string[] {
  return input
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
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
