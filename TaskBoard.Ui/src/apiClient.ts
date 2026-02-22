import type {
  EligibleTicketDto,
  EventDto,
  PickNextResult,
  TicketDepsResponse,
  TicketDto,
  TicketFilters,
  TicketsPage,
  ValidateResponse,
} from './types'

interface RawRunDto {
  ticket_id: string
  phase: string
  attempt: number
  lock_owner: string | null
  lock_expires_at: string | null
  branch: string | null
  pr_number: number | null
  last_ci_state: string
  last_summary: string | null
  last_error: string | null
  updated_at: string
}

interface RawTicketDto {
  id: string
  title: string
  status: string
  priority: number
  repo: string
  labels: string[]
  acceptance_criteria: string[]
  test_plan: string | null
  description: string | null
  created_at: string
  updated_at: string
  run: RawRunDto | null
}

interface RawEligibleTicketDto {
  ticket_id: string
  title: string
  priority: number
  repo: string
  blockers: number
  status: string
}

interface RawPickNextReasons {
  downstream_unblocked_count: number
  critical_path_depth: number
  priority: number
  score: number
  has_active_lock: boolean
  all_blockers_done: boolean
}

interface RawPickNextResult {
  ticket_id: string | null
  score: number | null
  reasons: RawPickNextReasons | null
  reason: string | null
}

interface RawEventDto {
  id: number
  ticket_id: string | null
  type: string
  payload: unknown
  created_at: string
}

export class ApiError extends Error {
  status: number
  payload: unknown

  constructor(status: number, payload: unknown) {
    super(`API error (${status})`)
    this.status = status
    this.payload = payload
  }
}

interface ClientOptions {
  token: string
  baseUrl?: string
  onUnauthorized?: () => void
}

export interface TicketPayload {
  title: string
  status: string
  priority: number
  repo: string
  labels: string[]
  acceptanceCriteria: string[]
  testPlan: string
  description: string
}

export interface TicketPatchPayload {
  title: string
  status: string
  priority: number
  repo: string
  labels: string[]
  acceptanceCriteria: string[]
  testPlan: string
  description: string
}

export class TaskBoardApiClient {
  private token: string
  private baseUrl: string
  private onUnauthorized?: () => void

  constructor(options: ClientOptions) {
    this.token = options.token
    const explicit = options.baseUrl?.trim().replace(/\/$/, '')
    this.baseUrl = explicit ?? (typeof window !== 'undefined' ? window.location.origin : '')
    this.onUnauthorized = options.onUnauthorized
  }

  async getTickets(filters: TicketFilters): Promise<TicketsPage> {
    const params = new URLSearchParams()
    if (filters.status) params.set('status', filters.status)
    if (filters.repo) params.set('repo', filters.repo)
    if (filters.label) params.set('label', filters.label)
    if (filters.q) params.set('q', filters.q)
    if (filters.limit != null) params.set('limit', String(filters.limit))
    if (filters.offset != null) params.set('offset', String(filters.offset))
    const suffix = params.size > 0 ? `?${params.toString()}` : ''

    const data = await this.request<{
      total: number
      limit: number
      offset: number
      items: RawTicketDto[]
    }>(`/tickets${suffix}`)
    return {
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      items: data.items.map(mapTicket),
    }
  }

  async getDepsBatch(ticketIds: string[]): Promise<Record<string, TicketDepsResponse>> {
    if (ticketIds.length === 0) return {}
    const ids = ticketIds.join(',')
    const raw = await this.request<Record<string, { blocked_by: string[]; blocks: string[] }>>(
      `/deps?ids=${encodeURIComponent(ids)}`,
    )
    const result: Record<string, TicketDepsResponse> = {}
    for (const [id, value] of Object.entries(raw)) {
      result[id] = { blocked_by: value.blocked_by, blocks: value.blocks }
    }
    return result
  }

  async createTicket(payload: TicketPayload): Promise<TicketDto> {
    const data = await this.request<RawTicketDto>('/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: payload.title,
        status: payload.status,
        priority: payload.priority,
        repo: payload.repo,
        labels: payload.labels,
        acceptance_criteria: payload.acceptanceCriteria,
        test_plan: payload.testPlan,
        description: payload.description,
      }),
    })
    return mapTicket(data)
  }

  async patchTicket(ticketId: string, payload: TicketPatchPayload): Promise<TicketDto> {
    const data = await this.request<RawTicketDto>(`/tickets/${ticketId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: payload.title,
        status: payload.status,
        priority: payload.priority,
        repo: payload.repo,
        labels: payload.labels,
        acceptance_criteria: payload.acceptanceCriteria,
        test_plan: payload.testPlan,
        description: payload.description,
      }),
    })
    return mapTicket(data)
  }

  async transitionTicket(ticketId: string, to: string): Promise<TicketDto> {
    const data = await this.request<RawTicketDto>(`/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to, note: 'kanban drag', by: 'user', force: false }),
    })
    return mapTicket(data)
  }

  async deleteTicket(ticketId: string): Promise<void> {
    await this.request<void>(`/tickets/${ticketId}`, {
      method: 'DELETE',
    })
  }

  async getDeps(ticketId: string): Promise<TicketDepsResponse> {
    return this.request<TicketDepsResponse>(`/tickets/${ticketId}/deps`)
  }

  async replaceDeps(ticketId: string, blockedBy: string[]): Promise<void> {
    await this.request<void>(`/tickets/${ticketId}/deps`, {
      method: 'PUT',
      body: JSON.stringify({ blocked_by: blockedBy }),
    })
  }

  async getEligible(repo?: string): Promise<EligibleTicketDto[]> {
    const suffix = repo ? `?repo=${encodeURIComponent(repo)}` : ''
    const data = await this.request<RawEligibleTicketDto[]>(`/eligible${suffix}`)
    return data.map(mapEligibleTicket)
  }

  async pickNext(repo?: string): Promise<PickNextResult> {
    const suffix = repo ? `?repo=${encodeURIComponent(repo)}` : ''
    const data = await this.request<RawPickNextResult>(`/pick-next${suffix}`)
    return mapPickNext(data)
  }

  async validate(): Promise<ValidateResponse> {
    return this.request<ValidateResponse>('/validate')
  }

  async getEvents(ticketId: string): Promise<EventDto[]> {
    const data = await this.request<RawEventDto[]>(
      `/events?ticket_id=${encodeURIComponent(ticketId)}&limit=50`,
    )
    return data.map(mapEvent)
  }

  async postTicketUpdate(ticketId: string, message: string, author?: string): Promise<EventDto> {
    const data = await this.request<RawEventDto>(`/tickets/${ticketId}/updates`, {
      method: 'POST',
      body: JSON.stringify({ message, author: author ?? undefined }),
    })
    return mapEvent(data)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    if (response.status === 401) {
      this.onUnauthorized?.()
    }

    if (!response.ok) {
      const payload = await safeParseJson(response)
      throw new ApiError(response.status, payload)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }
}

async function safeParseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function mapRun(run: RawRunDto): NonNullable<TicketDto['run']> {
  return {
    ticketId: run.ticket_id,
    phase: run.phase,
    attempt: run.attempt,
    lockOwner: run.lock_owner,
    lockExpiresAt: run.lock_expires_at,
    branch: run.branch,
    prNumber: run.pr_number,
    lastCiState: run.last_ci_state,
    lastSummary: run.last_summary,
    lastError: run.last_error,
    updatedAt: run.updated_at,
  }
}

function mapTicket(ticket: RawTicketDto): TicketDto {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status as TicketDto['status'],
    priority: ticket.priority,
    repo: ticket.repo,
    labels: ticket.labels,
    acceptanceCriteria: ticket.acceptance_criteria,
    testPlan: ticket.test_plan,
    description: ticket.description,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    run: ticket.run ? mapRun(ticket.run) : null,
  }
}

function mapEligibleTicket(ticket: RawEligibleTicketDto): EligibleTicketDto {
  return {
    ticketId: ticket.ticket_id,
    title: ticket.title,
    priority: ticket.priority,
    repo: ticket.repo,
    blockers: ticket.blockers,
    status: ticket.status,
  }
}

function mapPickNext(data: RawPickNextResult): PickNextResult {
  return {
    ticketId: data.ticket_id,
    score: data.score,
    reason: data.reason,
    reasons: data.reasons
      ? {
          downstreamUnblockedCount: data.reasons.downstream_unblocked_count,
          criticalPathDepth: data.reasons.critical_path_depth,
          priority: data.reasons.priority,
          score: data.reasons.score,
          hasActiveLock: data.reasons.has_active_lock,
          allBlockersDone: data.reasons.all_blockers_done,
        }
      : null,
  }
}

function mapEvent(event: RawEventDto): EventDto {
  return {
    id: event.id,
    ticketId: event.ticket_id,
    type: event.type,
    payload: event.payload,
    createdAt: event.created_at,
  }
}
