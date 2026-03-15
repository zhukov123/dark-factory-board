import { describe, expect, it } from 'vitest'
import { simulateDoneUnlocks } from './scoring'
import type { TicketDto } from './types'

describe('simulateDoneUnlocks', () => {
  it('returns tickets that become newly eligible', () => {
    const tickets: TicketDto[] = [
      {
        id: 'T1',
        title: 'A',
        status: 'Ready',
        priority: 1,
        repo: '',
        labels: [],
        acceptanceCriteria: [],
        testPlan: null,
        description: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        lastStatusNote: null,
        run: null,
      },
      {
        id: 'T2',
        title: 'B',
        status: 'Ready',
        priority: 1,
        repo: '',
        labels: [],
        acceptanceCriteria: [],
        testPlan: null,
        description: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        lastStatusNote: null,
        run: null,
      },
    ]

    const blockers = {
      T1: [],
      T2: ['T1'],
    }

    expect(simulateDoneUnlocks('T1', tickets, blockers)).toEqual(['T2'])
  })
})
