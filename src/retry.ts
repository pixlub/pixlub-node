// Only requests that cannot cause a second charge are retried.

const INITIAL_BACKOFF = 0.5
const MAX_BACKOFF = 8
const MAX_RETRY_AFTER = 60
export const UPLOAD_INCOMPLETE_ATTEMPTS = 5
const UPLOAD_INCOMPLETE_FIRST_PAUSE = 1

const RETRYABLE_GET_STATUSES = new Set([500, 502, 503, 504])
const RETRYABLE_PUT_STATUSES = new Set([500, 502, 503, 504, 507])

export interface Failure {
  kind: string
  retryable: boolean
  requestSent: boolean
  timedOut: boolean
}

export function failureFor(kind: string, method: string, options: { sent: boolean; timedOut: boolean }): Failure {
  return {
    kind,
    // A request the server never saw cannot be charged twice; GET and PUT are idempotent.
    retryable: !options.sent || method === 'GET' || method === 'PUT',
    requestSent: options.sent,
    timedOut: options.timedOut,
  }
}

export function statusIsRetryable(method: string, status: number): boolean {
  if (status === 429) return true
  if (method === 'PUT') return RETRYABLE_PUT_STATUSES.has(status)
  return method === 'GET' && RETRYABLE_GET_STATUSES.has(status)
}

export function uploadIncompletePause(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(Math.max(retryAfter, 0), MAX_RETRY_AFTER)
  return Math.min(MAX_BACKOFF, UPLOAD_INCOMPLETE_FIRST_PAUSE * 2 ** attempt)
}

export function backoffSeconds(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(Math.max(retryAfter, 0), MAX_RETRY_AFTER)
  const ceiling = Math.min(MAX_BACKOFF, INITIAL_BACKOFF * 2 ** attempt)
  return ceiling * (0.5 + Math.random() * 0.5)
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number(text)
  // Only an HTTP date (RFC 9110), not any text Date.parse would accept.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined
  const when = Date.parse(text)
  if (Number.isNaN(when)) return undefined
  return Math.max(0, (when - Date.now()) / 1000)
}
