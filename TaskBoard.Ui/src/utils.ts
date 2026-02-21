import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from './apiClient'

export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}: ${JSON.stringify(error.payload)}`
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected error'
}

export function splitCsv(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

export function splitLines(input: string): string[] {
  return input
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

export async function invalidateBoard(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['tickets'] }),
    queryClient.invalidateQueries({ queryKey: ['deps-batch'] }),
    queryClient.invalidateQueries({ queryKey: ['eligible'] }),
    queryClient.invalidateQueries({ queryKey: ['pick-next'] }),
    queryClient.invalidateQueries({ queryKey: ['validate'] }),
  ])
}
