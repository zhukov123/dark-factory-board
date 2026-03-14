import { useCallback, useEffect, useRef, useState } from 'react'

interface LlmChunk {
  ticket_id: string
  phase: string
  delta: string
}

interface LlmStreamPanelProps {
  baseUrl: string
  token: string
  ticketIdFilter: string | null
  onUnauthorized?: () => void
}

export function LlmStreamPanel({
  baseUrl,
  token,
  ticketIdFilter,
  onUnauthorized,
}: LlmStreamPanelProps) {
  const [text, setText] = useState('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const disconnect = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setConnected(false)
  }, [])

  useEffect(() => {
    if (!token) return
    const url =
      ticketIdFilter && ticketIdFilter.trim()
        ? `${baseUrl.replace(/\/$/, '')}/stream/llm?ticket_id=${encodeURIComponent(ticketIdFilter.trim())}`
        : `${baseUrl.replace(/\/$/, '')}/stream/llm`
    setError(null)
    setText((prev) => (prev ? prev + '\n\n--- reconnecting ---\n\n' : ''))
    const ac = new AbortController()
    abortRef.current = ac

    let buffer = ''
    const run = async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        })
        if (res.status === 401) {
          onUnauthorized?.()
          setError('Unauthorized')
          return
        }
        if (!res.ok || !res.body) {
          setError(`HTTP ${res.status}`)
          return
        }
        setConnected(true)
        setError(null)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const payload = JSON.parse(line.slice(6)) as LlmChunk
                const delta = payload.delta ?? ''
                if (delta) {
                  setText((prev) => prev + delta)
                }
              } catch {
                // ignore parse errors for non-JSON data lines
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setError((e as Error).message ?? 'Connection failed')
      } finally {
        setConnected(false)
        abortRef.current = null
      }
    }
    run()
    return () => {
      ac.abort()
    }
  }, [baseUrl, token, ticketIdFilter, onUnauthorized])

  useEffect(() => {
    if (!preRef.current || !connected) return
    preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text, connected])

  return (
    <div className="llm-stream-panel">
      <div className="llm-stream-toolbar">
        <span className="llm-stream-status">
          {connected ? (
            <span className="llm-stream-dot llm-stream-dot-active" title="Receiving tokens" />
          ) : (
            <span className="llm-stream-dot" title="Disconnected" />
          )}
          {connected ? 'Streaming…' : 'Connected (waiting for worker)'}
        </span>
        <button type="button" className="secondary llm-stream-clear" onClick={() => setText('')}>
          Clear
        </button>
        <button type="button" className="secondary" onClick={disconnect}>
          Disconnect
        </button>
      </div>
      {error && (
        <div className="llm-stream-error">
          {error}
        </div>
      )}
      <pre ref={preRef} className="llm-stream-pre">
        {text || (connected ? 'Waiting for LLM tokens…' : 'Connect to see planner / implementer / reviewer output.')}
      </pre>
    </div>
  )
}
