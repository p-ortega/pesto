import { readTokenOnce } from './auth/token'
import { apiGet, ApiError, ProblemDetails } from './data/client'

interface NoiseFact {
  has_noise: boolean | null
  decided_by: string
  evidence: string[]
  notes: string[]
}

interface RunConfig {
  case: string
  n_par: number | null
  n_real: number | null
  noise: NoiseFact
}

function render(text: string): void {
  const app = document.getElementById('app')
  if (app) {
    app.textContent = text
  }
}

function noiseLabel(noise: NoiseFact): string {
  if (noise.has_noise === null) {
    return 'noise: unknown'
  }
  return noise.has_noise ? 'noise: yes' : 'noise: no'
}

// A failed read refuses with a reason naming what was tried -- never a blank
// page. The words are the server's own (title/artifact/detail), not invented
// here, since naming the artifact is the whole point of the error shape.
function renderProblem(problem: ProblemDetails): void {
  const parts = [problem.title]
  if (problem.artifact) {
    parts.push(`artifact: ${problem.artifact}`)
  }
  if (problem.detail) {
    parts.push(problem.detail)
  }
  render(parts.join(' -- '))
}

async function boot(): Promise<void> {
  readTokenOnce()

  try {
    const config = (await apiGet('/api/run/config')) as RunConfig
    render(
      `${config.case} -- n_par ${config.n_par ?? 'unknown'}, ` +
        `n_real ${config.n_real ?? 'unknown'}, ${noiseLabel(config.noise)}`,
    )
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.problem.status === 409) {
        render('no run is open')
        return
      }
      renderProblem(error.problem)
      return
    }
    throw error
  }
}

void boot()
