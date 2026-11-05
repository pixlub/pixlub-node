/** One request with retries, over fetch. */

import { clock } from './clock.js'
import { AbortedError, APIConnectionError, APITimeoutError } from './errors.js'
import type { Body } from './files.js'
import { backoffSeconds, failureFor, parseRetryAfter, statusIsRetryable, type Failure } from './retry.js'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** An answer, with its body read up to a size limit. */
export interface RawResponse {
  status: number
  headers: Headers
  body: Buffer
  /** The body was larger than allowed and was not kept. */
  tooLarge: boolean
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  headers: Record<string, string>
  /** Largest body read; a larger one gives `tooLarge`. */
  maxBytes: number
  body?: Body | undefined
  /** Milliseconds; overrides the client's timeout. */
  timeout?: number | undefined
  /** The answer may take this long (ms), however short the timeout. */
  readFloor?: number | undefined
  /** No retry once this returns true. */
  stop?: (() => boolean) | undefined
  signal?: AbortSignal | undefined
}

// Errors that mean the request never left this machine: it cannot have been charged.
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

type Outcome = { response: RawResponse } | { failure: Failure }

export class HttpTransport {
  constructor(
    private readonly fetch: Fetch,
    private readonly timeout: number,
    private readonly maxRetries: number,
  ) {}

  async request(spec: RequestSpec): Promise<RawResponse> {
    const timeout = spec.timeout ?? this.timeout
    let attempt = 0
    for (;;) {
      throwIfAborted(spec.signal)
      const outcome = await this.#sendOnce(spec, timeout)
      const canRetry = attempt < this.maxRetries && !spec.stop?.()
      if ('failure' in outcome) {
        if (outcome.failure.retryable && canRetry) {
          await pause(backoffSeconds(attempt), spec.signal)
          attempt++
          continue
        }
        throw connectionError(outcome.failure)
      }
      const response = outcome.response
      if (statusIsRetryable(spec.method, response.status) && canRetry) {
        await pause(backoffSeconds(attempt, retryHint(response)), spec.signal)
        attempt++
        continue
      }
      return response
    }
  }

  async #sendOnce(spec: RequestSpec, timeout: number): Promise<Outcome> {
    const controller = new AbortController()
    const signal = spec.signal
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const wait = Math.max(timeout, spec.readFloor ?? 0)
    // While a body is sent, each chunk taken resets the timer; then the answer may take `wait`.
    const dog = new Watchdog(spec.body ? timeout : wait, () => controller.abort(new TimedOut()))
    const state: { sent: boolean; inputError?: unknown } = { sent: false }
    const chunks = spec.body?.chunks()
    try {
      const headers = { ...spec.headers }
      let body: ReadableStream<Uint8Array> | undefined
      if (spec.body && chunks) {
        headers['content-type'] = spec.body.contentType
        headers['content-length'] = String(spec.body.length)
        body = bodyStream(chunks, dog, timeout, wait, state)
      }
      let answer: Response
      try {
        answer = await this.fetch(spec.url, {
          method: spec.method,
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
          ...(body ? { duplex: 'half' } : {}),
        } as RequestInit)
      } catch (error) {
        return { failure: classify(error, spec.method, state, dog, signal) }
      }
      dog.reset(timeout)
      try {
        const read = await readLimited(answer, spec.maxBytes, () => dog.reset(timeout))
        return { response: { status: answer.status, headers: answer.headers, ...read } }
      } catch (error) {
        state.sent = true
        return { failure: classify(error, spec.method, state, dog, signal) }
      }
    } finally {
      dog.stop()
      signal?.removeEventListener('abort', onAbort)
      // Closes the file being sent when the attempt stopped halfway.
      await chunks?.return(undefined).catch(() => undefined)
    }
  }
}

class TimedOut extends Error {
  constructor() {
    super('timed out')
    this.name = 'TimeoutError'
  }
}

class Watchdog {
  #timer: NodeJS.Timeout | undefined
  fired = false

  constructor(
    ms: number,
    private readonly onFire: () => void,
  ) {
    this.reset(ms)
  }

  reset(ms: number): void {
    if (this.fired) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.fired = true
      this.onFire()
    }, ms)
  }

  stop(): void {
    clearTimeout(this.#timer)
  }
}

function bodyStream(
  chunks: AsyncGenerator<Uint8Array>,
  dog: Watchdog,
  timeout: number,
  wait: number,
  state: { sent: boolean; inputError?: unknown },
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await chunks.next()
          if (next.done) {
            dog.reset(wait)
            controller.close()
            return
          }
          state.sent = true
          dog.reset(timeout)
          controller.enqueue(next.value)
        } catch (error) {
          state.inputError = error
          controller.error(error)
        }
      },
      async cancel() {
        await chunks.return(undefined).catch(() => undefined)
      },
    },
    // Nothing is read before fetch asks for it, so a chunk taken means the request left.
    { highWaterMark: 0 },
  )
}

async function readLimited(
  answer: Response,
  maxBytes: number,
  progress: () => void,
): Promise<{ body: Buffer; tooLarge: boolean }> {
  const declared = Number(answer.headers.get('content-length') ?? Number.NaN)
  if (!answer.body) return { body: Buffer.alloc(0), tooLarge: false }
  if (Number.isFinite(declared) && declared > maxBytes) {
    await answer.body.cancel().catch(() => undefined)
    return { body: Buffer.alloc(0), tooLarge: true }
  }
  const reader = answer.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { body: Buffer.alloc(0), tooLarge: true }
    }
    parts.push(value)
    progress()
  }
  return { body: Buffer.concat(parts, total), tooLarge: false }
}

function classify(
  error: unknown,
  method: string,
  state: { sent: boolean; inputError?: unknown },
  dog: Watchdog,
  signal: AbortSignal | undefined,
): Failure {
  if (signal?.aborted) throw abortedError(signal)
  if (state.inputError !== undefined) throw state.inputError
  if (dog.fired) return failureFor('timeout', method, { sent: true, timedOut: true })
  const found = errorCodes(error)
  if (!found.network) throw error
  const neverSent =
    !state.sent &&
    (found.codes.some(code => NEVER_SENT_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) ||
      found.syscalls.some(call => call === 'connect' || call === 'getaddrinfo'))
  return failureFor(found.codes[0] ?? 'network error', method, {
    sent: !neverSent,
    timedOut: found.codes.some(code => TIMEOUT_CODES.has(code)),
  })
}

/** Codes and system calls found in an error and its causes. */
function errorCodes(error: unknown): { network: boolean; codes: string[]; syscalls: string[] } {
  const codes: string[] = []
  const syscalls: string[] = []
  const seen = new Set<unknown>()
  const visit = (item: unknown, depth: number): void => {
    if (typeof item !== 'object' || item === null || seen.has(item) || depth > 8) return
    seen.add(item)
    const { code, syscall, cause, errors } = item as Record<string, unknown>
    if (typeof code === 'string') codes.push(code)
    if (typeof syscall === 'string') syscalls.push(syscall)
    visit(cause, depth + 1)
    if (Array.isArray(errors)) for (const inner of errors) visit(inner, depth + 1)
  }
  visit(error, 0)
  // fetch reports every network failure as a TypeError; anything else is a bug to surface.
  return { network: error instanceof TypeError || codes.length > 0, codes, syscalls }
}

function connectionError(failure: Failure): APIConnectionError {
  const hint = failure.requestSent
    ? ' The request may have reached the server: check your credit balance before retrying a tool run.'
    : ''
  if (failure.timedOut) {
    return new APITimeoutError(`The Pixlub API did not answer in time (${failure.kind}).${hint}`, {
      requestSent: failure.requestSent,
    })
  }
  return new APIConnectionError(
    `Could not reach the Pixlub API (${failure.kind}). Check the base URL and your network.${hint}`,
    { requestSent: failure.requestSent },
  )
}

function abortedError(signal: AbortSignal): AbortedError {
  return new AbortedError('The call was aborted.', { cause: signal.reason })
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError(signal)
}

/** The promise, or AbortedError as soon as the signal aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Waits `seconds`, or throws AbortedError as soon as the signal aborts. */
export async function pause(seconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  try {
    await clock.sleep(seconds, signal)
  } catch (error) {
    if (signal?.aborted) throw abortedError(signal)
    throw error
  }
}

/** Seconds to wait from a Retry-After header, or from `retry_after` in a small JSON body. */
export function retryHint(response: RawResponse): number | undefined {
  const header = parseRetryAfter(response.headers.get('retry-after'))
  if (header !== undefined) return header
  if (response.body.byteLength > 64 * 1024) return undefined
  const payload = jsonObject(response.body)
  return payload ? seconds(payload.retry_after) : undefined
}

export function jsonObject(body: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
