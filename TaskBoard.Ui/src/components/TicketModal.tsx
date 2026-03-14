import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { TaskBoardApiClient, TicketPatchPayload } from '../apiClient'
import { formatError, invalidateBoard, splitCsv, splitLines } from '../utils'
import { STATUSES, type TicketDto, type TicketStatus } from '../types'
import { WorkerActivityFeed } from './WorkerActivityFeed'

export function TicketModal({
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
  const [editDraft, setEditDraft] = useState({
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
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateAuthor, setUpdateAuthor] = useState('')
  const [depsCollapsed, setDepsCollapsed] = useState(true)
  const [runStateCollapsed, setRunStateCollapsed] = useState(true)
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

  const releaseRunMutation = useMutation({
    mutationFn: (owner: string) => client.releaseRun(ticket.id, owner),
    onSuccess: () => {
      onError('')
      void invalidateBoard(queryClient)
      void queryClient.invalidateQueries({ queryKey: ['events', ticket.id] })
    },
    onError: (error) => onError(formatError(error)),
  })

  const approveRunMutation = useMutation({
    mutationFn: (payload: { decisionId: string; note?: string }) =>
      client.approveRun(ticket.id, payload.decisionId, payload.note),
    onSuccess: () => {
      onError('')
      void invalidateBoard(queryClient)
      void queryClient.invalidateQueries({ queryKey: ['events', ticket.id] })
      void queryClient.invalidateQueries({ queryKey: ['tickets', ticket.id] })
    },
    onError: (error) => onError(formatError(error)),
  })

  const rejectRunMutation = useMutation({
    mutationFn: (payload: { decisionId: string; note?: string }) =>
      client.rejectRun(ticket.id, payload.decisionId, payload.note),
    onSuccess: () => {
      onError('')
      void invalidateBoard(queryClient)
      void queryClient.invalidateQueries({ queryKey: ['events', ticket.id] })
      void queryClient.invalidateQueries({ queryKey: ['tickets', ticket.id] })
    },
    onError: (error) => onError(formatError(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: () => client.deleteTicket(ticket.id),
    onSuccess: onDeleted,
    onError: (error) => onError(formatError(error)),
  })

  const postUpdateMutation = useMutation({
    mutationFn: (payload: { message: string; author?: string }) =>
      client.postTicketUpdate(ticket.id, payload.message, payload.author),
    onSuccess: () => {
      setUpdateMessage('')
      void queryClient.invalidateQueries({ queryKey: ['events', ticket.id] })
    },
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

        <div className="ticket-modal-body">
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

          <div className="ticket-modal-right">
            <div className="collapsible-section">
              <button
                type="button"
                className="collapsible-header"
                onClick={() => setDepsCollapsed((c) => !c)}
                aria-expanded={!depsCollapsed}
              >
                <span className="collapsible-chevron">{depsCollapsed ? '▶' : '▼'}</span>
                <span>Dependencies</span>
                {depsDraft.length > 0 && (
                  <span className="collapsible-badge">{depsDraft.length}</span>
                )}
              </button>
              {!depsCollapsed && (
                <div className="collapsible-content">
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
                </div>
              )}
            </div>

            <div className="collapsible-section">
              <button
                type="button"
                className="collapsible-header"
                onClick={() => setRunStateCollapsed((c) => !c)}
                aria-expanded={!runStateCollapsed}
              >
                <span className="collapsible-chevron">{runStateCollapsed ? '▶' : '▼'}</span>
                <span>Run State</span>
              </button>
              {!runStateCollapsed && (
                <div className="collapsible-content">
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
                    {(ticket.run?.prUrl ?? ticket.run?.prNumber != null) && (
                      <>
                        <dt>PR</dt>
                        <dd>
                          {ticket.run.prUrl ? (
                            <a href={ticket.run.prUrl} target="_blank" rel="noopener noreferrer">
                              Open PR
                            </a>
                          ) : (
                            <>#{ticket.run!.prNumber}</>
                          )}
                        </dd>
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
                  {ticket.run != null &&
                    ticket.run.phase?.toLowerCase() === 'awaitingapproval' &&
                    ticket.run.pendingApprovalDecisionId &&
                    ticket.run.workflowId && (
                    <div className="run-actions run-approval-actions">
                      <p className="run-approval-heading">Reviewer marked this run as risky. Decide whether to continue.</p>
                      <div className="run-approval-buttons">
                        <button
                          type="button"
                          className="run-approve-btn"
                          disabled={approveRunMutation.isPending || rejectRunMutation.isPending}
                          onClick={() =>
                            approveRunMutation.mutate({
                              decisionId: ticket.run!.pendingApprovalDecisionId!,
                            })
                          }
                        >
                          {approveRunMutation.isPending ? 'Sending…' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          className="run-reject-btn"
                          disabled={approveRunMutation.isPending || rejectRunMutation.isPending}
                          onClick={() =>
                            rejectRunMutation.mutate({
                              decisionId: ticket.run!.pendingApprovalDecisionId!,
                            })
                          }
                        >
                          {rejectRunMutation.isPending ? 'Sending…' : 'Reject'}
                        </button>
                      </div>
                      <span className="run-action-hint">
                        Approve: workflow continues (tests, PR). Reject: run is released, ticket stays Blocked.
                      </span>
                    </div>
                  )}
                  {ticket.run != null && ticket.run.lockOwner != null && (
                    <div className="run-actions">
                      <button
                        type="button"
                        className="release-run-btn"
                        disabled={releaseRunMutation.isPending}
                        onClick={() =>
                          releaseRunMutation.mutate(ticket.run!.lockOwner ?? 'worker-1')
                        }
                      >
                        {releaseRunMutation.isPending ? 'Releasing…' : 'Release run'}
                      </button>
                      <span className="run-action-hint">
                        Clears the lock so another run can claim this ticket. Use if the worker died or the run is stuck.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <WorkerActivityFeed
              ticketId={ticket.id}
              ticketStatus={ticket.status}
              client={client}
              fallbackEvents={eventsQuery.data}
            />

            <section className="activity-section" style={{ marginTop: '0.6rem' }}>
              <div className="modal-section-label">Post Update</div>
              <div className="activity-post">
                <input
                  type="text"
                  placeholder="Post an update…"
                  value={updateMessage}
                  onChange={(e) => setUpdateMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (updateMessage.trim()) {
                        postUpdateMutation.mutate({
                          message: updateMessage.trim(),
                          author: updateAuthor.trim() || undefined,
                        })
                      }
                    }
                  }}
                />
                <input
                  type="text"
                  className="activity-author"
                  placeholder="Author"
                  value={updateAuthor}
                  onChange={(e) => setUpdateAuthor(e.target.value)}
                />
                <button
                  type="button"
                  disabled={!updateMessage.trim() || postUpdateMutation.isPending}
                  onClick={() => {
                    if (updateMessage.trim()) {
                      postUpdateMutation.mutate({
                        message: updateMessage.trim(),
                        author: updateAuthor.trim() || undefined,
                      })
                    }
                  }}
                >
                  {postUpdateMutation.isPending ? 'Posting…' : 'Post'}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
