import { readTokenOnce } from './auth/token'
import { apiGet, ApiError } from './data/client'

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

async function boot(): Promise<void> {
  readTokenOnce()

  try {
    const config = (await apiGet('/api/run/config')) as RunConfig
    render(
      `${config.case} -- n_par ${config.n_par ?? 'unknown'}, ` +
        `n_real ${config.n_real ?? 'unknown'}, ${noiseLabel(config.noise)}`,
    )
  } catch (error) {
    if (error instanceof ApiError && error.problem.status === 409) {
      render('no run is open')
      return
    }
    throw error
  }
}

void boot()
