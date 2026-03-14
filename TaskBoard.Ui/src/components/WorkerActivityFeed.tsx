import { useEffect, useRef, useState } from 'react'
import type { TaskBoardApiClient } from '../apiClient'
import type { EventDto } from '../types'

interface WorkerEvent {
  id: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

type PhaseGroup = {
  phase: string
  detail: string
  events: WorkerEvent[]
  done: boolean
  startedAt: string
}

const WORKER_EVENT_TYPES = new Set([
  'worker.phase',
  'worker.plan',
  'worker.tool_call',
  'worker.file_edit',
  'worker.verdict',
  'worker.pr',
])

function parseWorkerEvent(raw: {
  id: number
  type: string
  payload: unknown
  created_at?: string
  createdAt?: string
}): WorkerEvent | null {
  if (!WORKER_EVENT_TYPES.has(raw.type)) return null
  return {
    id: raw.id,
    type: raw.type,
    payload: (raw.payload as Record<string, unknown>) ?? {},
    createdAt: raw.created_at ?? raw.createdAt ?? new Date().toISOString(),
  }
}

function groupIntoPhases(events: WorkerEvent[]): PhaseGroup[] {
  const groups: PhaseGroup[] = []
  let current: PhaseGroup | null = null

  for (const ev of events) {
    if (ev.type === 'worker.phase') {
      const phase = String(ev.payload.phase ?? '')
      const detail = String(ev.payload.detail ?? '')
      const isDone = detail === 'done' || detail.startsWith('done')

      if (isDone && current && current.phase === phase) {
        current.done = true
        current = null
        continue
      }

      current = {
        phase,
        detail,
        events: [],
        done: false,
        startedAt: ev.createdAt,
      }
      groups.push(current)
    } else if (current) {
      current.events.push(ev)
    } else {
      current = {
        phase: '_unknown',
        detail: '',
        events: [ev],
        done: false,
        startedAt: ev.createdAt,
      }
      groups.push(current)
    }
  }

  return groups
}

function ToolIcon({ tool }: { tool: string }) {
  switch (tool) {
    case 'write_file':
      return <span className="waf-icon waf-icon-pencil" title="write_file">✏</span>
    case 'read_file':
      return <span className="waf-icon waf-icon-eye" title="read_file">👁</span>
    case 'run_command':
      return <span className="waf-icon waf-icon-terminal" title="run_command">⏵</span>
    default:
      return <span className="waf-icon" title={tool}>⚙</span>
  }
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const cls =
    verdict === 'pass' ? 'waf-verdict-pass' :
    verdict === 'fail' ? 'waf-verdict-fail' :
    'waf-verdict-risky'
  return <span className={`waf-verdict ${cls}`}>{verdict}</span>
}

function formatRelTime(isoStr: string): string {
  const d = new Date(isoStr)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function extractCmdResult(summary: string): string {
  const m = summary.match(/^exit=(\d+)/)
  if (m) return `exit ${m[1]}`
  if (summary.startsWith('Error:')) return 'error'
  if (summary.includes('timed out')) return 'timeout'
  return ''
}

function PhaseSection({
  group,
  defaultExpanded,
}: {
  group: PhaseGroup
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  const phaseLabel = group.phase.replace(/_/g, ' ').toUpperCase()

  return (
    <div className={`waf-phase ${group.done ? 'waf-phase-done' : 'waf-phase-active'}`}>
      <button
        type="button"
        className="waf-phase-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`waf-dot ${group.done ? 'waf-dot-done' : 'waf-dot-active'}`} />
        <span className="waf-phase-label">{phaseLabel}</span>
        {group.detail && group.detail !== 'done' && (
          <span className="waf-phase-detail">{group.detail}</span>
        )}
        <span className="waf-phase-time">{formatRelTime(group.startedAt)}</span>
        <span className="waf-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && group.events.length > 0 && (
        <div className="waf-phase-body">
          {group.events.map((ev) => (
            <EventRow key={ev.id} event={ev} />
          ))}
        </div>
      )}
    </div>
  )
}

function EventRow({ event }: { event: WorkerEvent }) {
  const p = event.payload

  if (event.type === 'worker.plan') {
    const items = (p.items as string[]) ?? []
    return (
      <div className="waf-plan">
        {items.map((item, i) => (
          <div key={i} className="waf-plan-item">
            <span className="waf-plan-num">{i + 1}.</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    )
  }

  if (event.type === 'worker.tool_call') {
    const tool = String(p.tool ?? '')
    const argsSummary = String(p.args_summary ?? '')
    const resultSummary = String(p.result_summary ?? '')

    let argDisplay = ''
    try {
      const parsed = JSON.parse(argsSummary)
      if (tool === 'write_file' || tool === 'read_file') {
        argDisplay = parsed.relative_path ?? argsSummary
      } else if (tool === 'run_command') {
        argDisplay = parsed.cmd ?? argsSummary
      } else {
        argDisplay = argsSummary
      }
    } catch {
      argDisplay = argsSummary
    }

    const cmdResult = tool === 'run_command' ? extractCmdResult(resultSummary) : ''

    return (
      <div className="waf-tool-call">
        <ToolIcon tool={tool} />
        <span className="waf-tool-name">{tool}</span>
        <span className="waf-tool-arg">{argDisplay}</span>
        {cmdResult && <span className="waf-tool-result">{cmdResult}</span>}
      </div>
    )
  }

  if (event.type === 'worker.file_edit') {
    const path = String(p.path ?? '')
    const lines = p.lines != null ? Number(p.lines) : null
    return (
      <div className="waf-tool-call">
        <ToolIcon tool="write_file" />
        <span className="waf-tool-name">write_file</span>
        <span className="waf-tool-arg">{path}</span>
        {lines != null && <span className="waf-tool-result">{lines} lines</span>}
      </div>
    )
  }

  if (event.type === 'worker.verdict') {
    const verdict = String(p.verdict ?? 'pass')
    const summary = String(p.summary ?? '')
    return (
      <div className="waf-verdict-row">
        <VerdictBadge verdict={verdict} />
        {summary && <span className="waf-verdict-summary">{summary}</span>}
      </div>
    )
  }

  if (event.type === 'worker.pr') {
    const action = String(p.action ?? '')
    const url = p.url ? String(p.url) : null
    const prNum = p.pr_number != null ? Number(p.pr_number) : null
    const branch = p.branch ? String(p.branch) : null

    let label = action
    if (action === 'pushed' && branch) label = `pushed ${branch}`
    if (action === 'created' && prNum) label = `PR #${prNum} created`
    if (action === 'merged' && prNum) label = `PR #${prNum} merged`
    if (action === 'merge_failed') label = `PR #${prNum ?? '?'} merge failed`

    return (
      <div className="waf-pr-row">
        <span className="waf-pr-arrow">→</span>
        <span className="waf-pr-label">{label}</span>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="waf-pr-link">
            view
          </a>
        )}
      </div>
    )
  }

  return null
}

export function WorkerActivityFeed({
  ticketId,
  ticketStatus,
  client,
  fallbackEvents,
}: {
  ticketId: string
  ticketStatus: string
  client: TaskBoardApiClient
  fallbackEvents?: EventDto[]
}) {
  const [events, setEvents] = useState<WorkerEvent[]>([])
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const isLive = ticketStatus === 'InProgress'

  useEffect(() => {
    if (!isLive) {
      if (abortRef.current) abortRef.current.abort()
      setStreaming(false)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    const startStream = async () => {
      const baseUrl = client.getApiBaseUrl()
      const token = client.getAuthToken()
      const url = `${baseUrl}/events/stream?ticket_id=${encodeURIComponent(ticketId)}`

      try {
        setStreaming(true)
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          setStreaming(false)
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          let eventType = ''
          let dataLine = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              dataLine = line.slice(6)
            } else if (line === '' && eventType && dataLine) {
              try {
                const parsed = JSON.parse(dataLine)
                const ev = parseWorkerEvent({
                  id: parsed.id,
                  type: eventType,
                  payload: parsed.payload,
                  created_at: parsed.created_at,
                })
                if (ev) {
                  setEvents((prev) => {
                    if (prev.some((e) => e.id === ev.id)) return prev
                    return [...prev, ev]
                  })
                }
              } catch {
                // ignore malformed SSE data
              }
              eventType = ''
              dataLine = ''
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setStreaming(false)
      }
    }

    startStream()

    return () => {
      controller.abort()
      setStreaming(false)
    }
  }, [isLive, ticketId, client])

  useEffect(() => {
    if (!isLive && fallbackEvents) {
      const workerEvs = fallbackEvents
        .map((e) =>
          parseWorkerEvent({
            id: e.id,
            type: e.type,
            payload: e.payload as Record<string, unknown>,
            createdAt: e.createdAt,
          }),
        )
        .filter((e): e is WorkerEvent => e !== null)
      setEvents(workerEvs)
    }
  }, [isLive, fallbackEvents])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [events])

  const groups = groupIntoPhases(events)
  const hasWorkerEvents = events.length > 0

  return (
    <div className="waf-container">
      <div className="waf-header">
        <span className="waf-title">Worker Activity</span>
        {streaming && (
          <span className="waf-live-badge">
            <span className="waf-live-dot" />
            LIVE
          </span>
        )}
      </div>
      <div className="waf-feed">
        {!hasWorkerEvents && (
          <div className="waf-empty">
            {isLive ? 'Waiting for worker events…' : 'No worker activity recorded.'}
          </div>
        )}
        {groups.map((g, i) => (
          <PhaseSection
            key={`${g.phase}-${g.startedAt}-${i}`}
            group={g}
            defaultExpanded={!g.done || i === groups.length - 1}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
