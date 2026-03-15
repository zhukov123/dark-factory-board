export const STATUSES = [
  'Backlog',
  'Ready',
  'InProgress',
  'Review',
  'Done',
  'Blocked',
] as const

export type TicketStatus = (typeof STATUSES)[number]

export interface RunDto {
  ticketId: string
  phase: string
  attempt: number
  lockOwner: string | null
  lockExpiresAt: string | null
  branch: string | null
  prNumber: number | null
  prUrl: string | null
  lastCiState: string
  lastSummary: string | null
  lastError: string | null
  pendingApprovalDecisionId: string | null
  workflowId: string | null
  updatedAt: string
}

export interface TicketDto {
  id: string
  title: string
  status: TicketStatus
  priority: number
  repo: string
  labels: string[]
  acceptanceCriteria: string[]
  testPlan: string | null
  description: string | null
  createdAt: string
  updatedAt: string
  lastStatusNote: string | null
  run: RunDto | null
}

export interface TicketDepsResponse {
  blocked_by: string[]
  blocks: string[]
}

export interface EligibleTicketDto {
  ticketId: string
  title: string
  priority: number
  repo: string
  blockers: number
  status: string
}

export interface PickNextReasons {
  downstreamUnblockedCount: number
  criticalPathDepth: number
  priority: number
  score: number
  hasActiveLock: boolean
  allBlockersDone: boolean
}

export interface PickNextResult {
  ticketId: string | null
  score: number | null
  reasons: PickNextReasons | null
  reason: string | null
}

export interface ValidateResponse {
  ok: boolean
  cycles: string[][]
}

export interface EventDto {
  id: number
  ticketId: string | null
  type: string
  payload: unknown
  createdAt: string
}

export type TicketDraft = {
  title: string
  status: TicketStatus
  priority: number
  repo: string
  labelsText: string
  acceptanceText: string
  testPlan: string
  description: string
}

export interface TicketFilters {
  status?: string
  repo?: string
  label?: string
  q?: string
  limit?: number
  offset?: number
}

export interface TicketsPage {
  total: number
  limit: number
  offset: number
  items: TicketDto[]
}
