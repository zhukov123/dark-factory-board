import type {
  EligibleTicketDto,
  EventDto,
  PickNextResult,
  TicketDepsResponse,
  TicketDto,
  TicketFilters,
  ValidateResponse,
} from './types'

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
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? ''
    this.onUnauthorized = options.onUnauthorized
  }

  async getTickets(filters: TicketFilters): Promise<TicketDto[]> {
    const params = new URLSearchParams()
    if (filters.status) params.set('status', filters.status)
    if (filters.repo) params.set('repo', filters.repo)
    if (filters.label) params.set('label', filters.label)
    if (filters.q) params.set('q', filters.q)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''

    return this.request<TicketDto[]>(`/tickets${suffix}`)
  }

  async createTicket(payload: TicketPayload): Promise<TicketDto> {
    return this.request<TicketDto>('/tickets', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async patchTicket(ticketId: string, payload: TicketPatchPayload): Promise<TicketDto> {
    return this.request<TicketDto>(`/tickets/${ticketId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  }

  async transitionTicket(ticketId: string, to: string): Promise<TicketDto> {
    return this.request<TicketDto>(`/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to, note: 'kanban drag', by: 'user', force: false }),
    })
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
    return this.request<EligibleTicketDto[]>(`/eligible${suffix}`)
  }

  async pickNext(repo?: string): Promise<PickNextResult> {
    const suffix = repo ? `?repo=${encodeURIComponent(repo)}` : ''
    return this.request<PickNextResult>(`/pick-next${suffix}`)
  }

  async validate(): Promise<ValidateResponse> {
    return this.request<ValidateResponse>('/validate')
  }

  async getEvents(ticketId: string): Promise<EventDto[]> {
    return this.request<EventDto[]>(`/events?ticket_id=${encodeURIComponent(ticketId)}&limit=50`)
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
  try {
    return await response.json()
  } catch {
    return await response.text()
  }
}
