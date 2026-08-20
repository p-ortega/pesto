import { authHeaders } from '../auth/token'

export interface ProblemDetails {
  type: string
  title: string
  status: number
  artifact?: string
  detail?: string
}

export class ApiError extends Error {
  problem: ProblemDetails

  constructor(problem: ProblemDetails) {
    super(problem.title)
    this.problem = problem
  }
}

export async function apiGet(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: authHeaders() })
  if (!response.ok) {
    const problem = (await response.json()) as ProblemDetails
    throw new ApiError(problem)
  }
  return response.json()
}
