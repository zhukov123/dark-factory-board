export interface WorkerEvent {
  id: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
  ticketId?: string | null
}

export const WORKER_EVENT_TYPES = new Set([
  'worker.phase',
  'worker.plan',
  'worker.tool_call',
  'worker.file_edit',
  'worker.verdict',
  'worker.pr',
])

export function parseWorkerEvent(raw: {
  id: number
  type: string
  payload: unknown
  created_at?: string
  createdAt?: string
  ticket_id?: string | null
  ticketId?: string | null
}): WorkerEvent | null {
  if (!WORKER_EVENT_TYPES.has(raw.type)) return null
  return {
    id: raw.id,
    type: raw.type,
    payload: (raw.payload as Record<string, unknown>) ?? {},
    createdAt: raw.created_at ?? raw.createdAt ?? new Date().toISOString(),
    ticketId: raw.ticket_id ?? raw.ticketId ?? null,
  }
}

export function formatRelTime(isoStr: string): string {
  const d = new Date(isoStr)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function extractCmdResult(summary: string): string {
  const m = summary.match(/^exit=(\d+)/)
  if (m) return `exit ${m[1]}`
  if (summary.startsWith('Error:')) return 'error'
  if (summary.includes('timed out')) return 'timeout'
  return ''
}

export function ToolIcon({ tool }: { tool: string }) {
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

export function VerdictBadge({ verdict }: { verdict: string }) {
  const cls =
    verdict === 'pass' ? 'waf-verdict-pass' :
    verdict === 'fail' ? 'waf-verdict-fail' :
    'waf-verdict-risky'
  return <span className={`waf-verdict ${cls}`}>{verdict}</span>
}

export function EventRow({ event }: { event: WorkerEvent }) {
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

  if (event.type === 'worker.phase') {
    const phase = String(p.phase ?? '').replace(/_/g, ' ').toUpperCase()
    const detail = String(p.detail ?? '')
    const isDone = detail === 'done' || detail.startsWith('done')
    const isWaitingLlm = !isDone && (detail === 'waiting for LLM response' || detail.includes('waiting for LLM'))
    return (
      <div
        className={`waf-tool-call ${isDone ? 'waf-phase-done-inline' : ''} ${isWaitingLlm ? 'waf-phase-waiting-llm' : ''}`}
      >
        <span className={`waf-dot ${isDone ? 'waf-dot-done' : 'waf-dot-active'}`} />
        <span className="waf-phase-label">{phase}</span>
        {detail && detail !== 'done' && (
          <span className="waf-phase-detail">{isWaitingLlm ? 'Waiting for LLM…' : detail}</span>
        )}
      </div>
    )
  }

  return null
}

const BADGE_COLORS = [
  '#58a6ff', '#f78166', '#d2a8ff', '#7ee787', '#ffa657',
  '#79c0ff', '#ff7b72', '#bb9af7', '#56d364', '#e3b341',
]

export function ticketColor(ticketId: string): string {
  let hash = 0
  for (let i = 0; i < ticketId.length; i++) {
    hash = (hash * 31 + ticketId.charCodeAt(i)) | 0
  }
  return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length]
}
