import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskBoardApiClient } from '../apiClient'
import {
  type WorkerEvent,
  WORKER_EVENT_TYPES,
  parseWorkerEvent,
  formatRelTime,
  EventRow,
  ticketColor,
} from './WorkerEventRenderers'

const MAX_BUFFER = 200

export function GlobalActivityMonitor({ client }: { client: TaskBoardApiClient }) {
  const [events, setEvents] = useState<WorkerEvent[]>([])
  const [streaming, setStreaming] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const feedRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller

    const startStream = async () => {
      const baseUrl = client.getApiBaseUrl()
      const token = client.getAuthToken()
      const url = `${baseUrl}/events/stream`

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
              if (WORKER_EVENT_TYPES.has(eventType)) {
                try {
                  const parsed = JSON.parse(dataLine)
                  const ev = parseWorkerEvent({
                    id: parsed.id,
                    type: eventType,
                    payload: parsed.payload,
                    created_at: parsed.created_at,
                    ticket_id: parsed.ticket_id,
                  })
                  if (ev) {
                    setEvents((prev) => {
                      if (prev.some((e) => e.id === ev.id)) return prev
                      const next = [...prev, ev]
                      return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
                    })
                  }
                } catch {
                  // ignore malformed SSE data
                }
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
  }, [client])

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [events, autoScroll])

  const handleScroll = useCallback(() => {
    const el = feedRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setAutoScroll(true)
  }, [])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  const activeTickets = new Set(events.filter((e) => e.ticketId).map((e) => e.ticketId!))

  return (
    <div className="gam-container">
      <div className="gam-header">
        <span className="gam-title">Activity Monitor</span>
        {streaming && (
          <span className="waf-live-badge">
            <span className="waf-live-dot" />
            LIVE
          </span>
        )}
        {activeTickets.size > 0 && (
          <span className="gam-active-count">
            {activeTickets.size} ticket{activeTickets.size !== 1 ? 's' : ''} active
          </span>
        )}
        <button type="button" className="gam-clear-btn" onClick={clearEvents}>
          Clear
        </button>
      </div>
      <div className="gam-feed" ref={feedRef} onScroll={handleScroll}>
        {events.length === 0 && (
          <div className="waf-empty">Waiting for worker events…</div>
        )}
        {events.map((ev) => (
          <div key={ev.id} className="gam-event-row">
            {ev.ticketId && (
              <span
                className="gam-ticket-badge"
                style={{ background: ticketColor(ev.ticketId) }}
              >
                {ev.ticketId}
              </span>
            )}
            <span className="gam-event-time">{formatRelTime(ev.createdAt)}</span>
            <div className="gam-event-content">
              <EventRow event={ev} />
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && events.length > 0 && (
        <button type="button" className="gam-jump-btn" onClick={jumpToLatest}>
          ↓ Jump to latest
        </button>
      )}
    </div>
  )
}
