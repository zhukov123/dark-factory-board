import { useEffect, useRef, useState } from 'react'
import type { TaskBoardApiClient } from '../apiClient'
import type { EventDto } from '../types'
import {
  type WorkerEvent,
  parseWorkerEvent,
  formatRelTime,
  EventRow,
} from './WorkerEventRenderers'

type PhaseGroup = {
  phase: string
  detail: string
  events: WorkerEvent[]
  done: boolean
  startedAt: string
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
