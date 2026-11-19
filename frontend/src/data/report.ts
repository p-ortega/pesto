// The problem report the server builds: text that is safe to post in public,
// and a link that opens a new GitHub issue with it filled in. pesto sends the
// report nowhere; the link is only followed when the user presses it.

import { apiGet } from './client'

export const NEW_ISSUE_URL = 'https://github.com/p-ortega/pesto/issues/new'

export interface ProblemReport {
  title: string
  body: string
  issueUrl: string
  /** True when the report is too long for a link, so the link carries a short note instead. */
  truncated: boolean
}

export async function fetchReport(): Promise<ProblemReport> {
  const raw = (await apiGet('/api/report')) as {
    title: string
    body: string
    issue_url: string
    truncated?: boolean
  }
  // Only a link to pesto's own new-issue page is ever opened, whatever the server sent.
  const issueUrl = typeof raw.issue_url === 'string' && raw.issue_url.startsWith(NEW_ISSUE_URL) ? raw.issue_url : NEW_ISSUE_URL
  return { title: raw.title, body: raw.body, issueUrl, truncated: raw.truncated === true }
}
