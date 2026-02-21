import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBoardApiClient } from './apiClient'

describe('TaskBoardApiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds bearer token header on requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ total: 0, limit: 100, offset: 0, items: [] }),
          { status: 200 },
        ),
      )

    const client = new TaskBoardApiClient({ token: 'abc123' })
    await client.getTickets({})

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>

    expect(headers.Authorization).toBe('Bearer abc123')
  })

  it('sends transition payload for drag/drop transitions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'T1',
            title: 'x',
            status: 'Review',
            priority: 1,
            repo: '',
            labels: [],
            acceptanceCriteria: [],
            testPlan: null,
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            run: null,
          }),
          { status: 200 },
        ),
      )

    const client = new TaskBoardApiClient({ token: 't' })
    await client.transitionTicket('T1', 'Review')

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/tickets/T1/transition')
    expect((init as RequestInit).method).toBe('POST')

    const payload = JSON.parse(((init as RequestInit).body as string) ?? '{}') as {
      to?: string
      by?: string
    }

    expect(payload.to).toBe('Review')
    expect(payload.by).toBe('user')
  })
})
