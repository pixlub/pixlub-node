/** Client for the Pixlub API. */

import { clock } from './clock.js'
import { keyMask, resolveApiKey, resolveBaseUrl } from './config.js'
import * as core from './core.js'
import {
  APIConnectionError,
  ConfigurationError,
  InvalidInputError,
  PixlubError,
  UnexpectedResponseError,
} from './errors.js'
import {
  type Body,
  DEFAULT_MAX_INPUT_BYTES,
  FileBody,
  type InputValue,
  type PreparedFile,
  prepareFile,
} from './files.js'
import { abortable, type Fetch, HttpTransport, pause, type RawResponse, retryHint, throwIfAborted } from './http.js'
import type { Tool, ToolOutput, ToolResult } from './models.js'
import { statusIsRetryable, uploadIncompletePause, UPLOAD_INCOMPLETE_ATTEMPTS } from './retry.js'

export interface ClientOptions {
  /** Your API key. Defaults to the `PIXLUB_API_KEY` environment variable. */
  apiKey?: string | undefined
  /** Defaults to `PIXLUB_BASE_URL`, then `https://api.pixlub.com`. */
  baseURL?: string | undefined
  /**
   * Longest wait, in milliseconds, for an answer or for the next bytes of a
   * transfer. Defaults to 180 000 (3 minutes).
   */
  timeout?: number | undefined
  /** From 0 to 5. Defaults to 2. */
  maxRetries?: number | undefined
  /** Largest local file accepted, in bytes. Defaults to 3 GiB. */
  maxInputBytes?: number | undefined
  /** Milliseconds to wait for a long run. Defaults to 1 800 000 (30 minutes). */
  jobTimeout?: number | undefined
  /** A fetch function to use, for proxies or custom TLS. Defaults to the global fetch. */
  fetch?: Fetch | undefined
}

export interface RequestOptions {
  /** Cancels the call: it then rejects with `AbortedError`. */
  signal?: AbortSignal | undefined
  /** Milliseconds; overrides the client's timeout for this call. */
  timeout?: number | undefined
}

export interface ListOptions extends RequestOptions {
  /** Leaves out the tools the API cannot run. */
  executableOnly?: boolean | undefined
}

export interface RunOptions extends RequestOptions {
  /**
   * The file of a tool with one input: a path, bytes, a Blob, a readable stream
   * or a `SourceURL`. An array for several files.
   */
  image?: InputValue | undefined
  /** Files keyed by input id, for tools with several inputs. */
  inputs?: Record<string, InputValue> | undefined
  /** The tool's settings. See `client.tools.schema(toolId)`. */
  params?: Record<string, unknown> | undefined
  /** Milliseconds; overrides the client's `jobTimeout` for this call. */
  jobTimeout?: number | undefined
}

/**
 * Client for the Pixlub API. Create one and reuse it.
 *
 * ```ts
 * import { Pixlub } from 'pixlub'
 *
 * const client = new Pixlub() // reads PIXLUB_API_KEY
 * const result = await client.tools.run('removeBgApi', { image: 'photo.jpg' })
 * await result.save(`photo-nobg${result.extension}`)
 * ```
 */
export class Pixlub {
  /** List and run tools. */
  readonly tools: Tools
  readonly baseURL: string
  readonly #context: Context

  constructor(options: ClientOptions = {}) {
    const apiKey = resolveApiKey(options.apiKey)
    this.baseURL = resolveBaseUrl(options.baseURL)
    const timeout = core.checkTimeout(options.timeout ?? core.DEFAULT_TIMEOUT, 'timeout')
    const maxRetries = core.checkRetries(options.maxRetries ?? 2)
    const fetchFn = options.fetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new PixlubError('No fetch function: use Node.js 22 or later, or pass { fetch }.')
    }
    this.#context = new Context({
      apiKey,
      baseUrl: this.baseURL,
      maxInputBytes: core.checkPositive(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, 'maxInputBytes'),
      jobTimeout: core.checkTimeout(options.jobTimeout ?? core.DEFAULT_JOB_TIMEOUT, 'jobTimeout'),
      http: new HttpTransport(fetchFn, timeout, maxRetries),
    })
    this.tools = new Tools(this.#context)
  }

  toString(): string {
    return `Pixlub(baseURL=${this.baseURL}, apiKey=${this.#context.masked})`
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }
}

/** List and run tools. Available as `client.tools`. */
export class Tools {
  readonly #context: Context

  /** @internal Use `client.tools`. */
  constructor(context: Context) {
    this.#context = context
  }

  /** Lists the tools. `executableOnly` leaves out those the API cannot run. */
  async list(options: ListOptions = {}): Promise<Tool[]> {
    const tools = await this.#context.catalog(checked(options), true)
    return options.executableOnly ? tools.filter(tool => tool.executable) : [...tools]
  }

  /** One tool. Rejects with `UnknownToolError` for an unknown id. */
  async retrieve(toolId: string, options: RequestOptions = {}): Promise<Tool> {
    const id = core.checkToolId(toolId)
    return core.knownTool(id, await this.#context.findTool(id, checked(options)))
  }

  /** JSON Schema of a tool's `params`. */
  async schema(toolId: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    const id = core.checkToolId(toolId)
    const payload = await this.#context.getJson(`/v1/modules/${id}/schema`, checked(options))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new UnexpectedResponseError('The parameter schema is not a JSON object.')
    }
    return payload as Record<string, unknown>
  }

  /**
   * Runs a tool and downloads what it produced.
   *
   * Large files are uploaded automatically, and long runs are awaited until
   * `jobTimeout`. Arguments are checked before anything is sent.
   *
   * @param toolId Such as `'removeBgApi'`. See `client.tools.list()`.
   */
  async run(toolId: string, options: RunOptions = {}): Promise<ToolResult> {
    const context = this.#context
    const id = core.checkToolId(toolId)
    checked(options)
    const jobTimeout =
      options.jobTimeout === undefined ? context.jobTimeout : core.checkTimeout(options.jobTimeout, 'jobTimeout')
    const tool = core.knownTool(id, await context.findTool(id, options))
    const plan = core.planRun(id, tool, options)

    const files: PreparedFile[] = []
    let response: RawResponse
    try {
      for (const [name, source] of plan.files) {
        throwIfAborted(options.signal)
        files.push(await prepareFile(source, name, context.maxInputBytes))
      }
      let transport = core.planTransport(plan, files)
      response = await this.#send(id, plan, transport, options)
      const directLimit = transport.upload === undefined ? core.wantsUpload(response) : undefined
      if (directLimit !== undefined) {
        transport = forcedUpload(plan, files, directLimit, response, context.apiKey)
        response = await this.#send(id, plan, transport, options)
      }
    } finally {
      await Promise.allSettled(files.map(file => file.close()))
    }
    return this.#finish(response, options, jobTimeout)
  }

  async #send(toolId: string, plan: core.RunPlan, transport: core.Transport, options: RunOptions): Promise<RawResponse> {
    const context = this.#context
    if (transport.upload === undefined) {
      return context.runRequest(toolId, core.runBody(plan, transport.direct), options)
    }
    const uploadId = await this.#upload(toolId, transport.upload, options)
    const body = core.runBody(plan, transport.direct, uploadId)
    for (let attempt = 1; ; attempt++) {
      const response = await context.runRequest(toolId, body, options)
      if (!core.uploadIncomplete(response) || attempt >= UPLOAD_INCOMPLETE_ATTEMPTS) return response
      await pause(uploadIncompletePause(attempt - 1, retryHint(response)), options.signal)
    }
  }

  async #upload(toolId: string, file: PreparedFile, options: RunOptions): Promise<string> {
    for (let tries = 0; tries < 2; tries++) {
      const ticket = await this.#context.openUpload(toolId, file, options)
      if (await this.#context.putUpload(ticket, file, options)) return ticket.uploadId
    }
    throw new UnexpectedResponseError(
      'The upload link expired twice in a row. Check your clock, and that the file can be sent within 15 minutes.',
    )
  }

  async #finish(response: RawResponse, options: RunOptions, jobTimeout: number): Promise<ToolResult> {
    const context = this.#context
    const jobId = response.status === 202 ? core.acceptedJobId(response, context.apiKey) : undefined
    let receipt: core.RunReceipt
    try {
      if (jobId !== undefined) response = await context.followJob(jobId, options, jobTimeout)
      receipt = core.receiptFromResponse(response, context.apiKey, context.baseUrl)
    } catch (error) {
      if (error instanceof PixlubError && error.jobId === undefined) {
        if (jobId !== undefined) core.afterAcceptance(error, { jobId })
        else if (response.status >= 200 && response.status < 300) {
          core.afterAcceptance(error, { runId: core.runIdOf(response) })
        }
      }
      throw error
    }
    let outputs: ToolOutput[]
    try {
      outputs = await context.downloadAll(receipt.outputs, options)
    } catch (error) {
      if (error instanceof PixlubError && error.jobId === undefined) {
        core.afterAcceptance(error, { jobId, runId: receipt.id })
      }
      throw error
    }
    return core.toolResult(receipt, outputs)
  }
}

/** Checks the options every method takes, before anything is sent. */
function checked<T extends RequestOptions>(options: T): T {
  if (typeof options !== 'object' || options === null) {
    throw new ConfigurationError('Options must be an object, such as { timeout: 30_000 }.')
  }
  if (options.timeout !== undefined) core.checkTimeout(options.timeout, 'timeout')
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ConfigurationError('signal must be an AbortSignal.')
  }
  throwIfAborted(options.signal)
  return options
}

function forcedUpload(
  plan: core.RunPlan,
  files: PreparedFile[],
  directLimit: number,
  refused: RawResponse,
  apiKey: string,
): core.Transport {
  try {
    return core.planTransport(plan, files, { forceUpload: true, directLimit: directLimit || undefined })
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error
  }
  throw core.errorFromResponse(refused, apiKey)
}

/** What the client knows, shared with `client.tools`. Not exported from the package. */
class Context {
  readonly apiKey: string
  readonly baseUrl: string
  readonly maxInputBytes: number
  readonly jobTimeout: number
  readonly http: HttpTransport
  #catalog: { at: number; tools: readonly Tool[] } | undefined
  #pending: Promise<readonly Tool[]> | undefined

  constructor(fields: {
    apiKey: string
    baseUrl: string
    maxInputBytes: number
    jobTimeout: number
    http: HttpTransport
  }) {
    this.apiKey = fields.apiKey
    this.baseUrl = fields.baseUrl
    this.maxInputBytes = fields.maxInputBytes
    this.jobTimeout = fields.jobTimeout
    this.http = fields.http
  }

  get masked(): string {
    return keyMask(this.apiKey)
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Context(baseUrl=${this.baseUrl}, apiKey=${this.masked})`
  }

  async getJson(path: string, options: RequestOptions): Promise<unknown> {
    const response = await this.http.request({
      method: 'GET',
      url: this.baseUrl + path,
      headers: core.requestHeaders(this.apiKey, 'application/json'),
      maxBytes: core.MAX_JSON_BYTES,
      timeout: options.timeout,
      signal: options.signal,
    })
    return core.jsonBody(response, this.apiKey)
  }

  /**
   * The catalog, fetched again when `refresh` or older than ten minutes. Concurrent
   * calls share one fetch; a call that is aborted stops waiting for it, the others do not.
   */
  async catalog(options: RequestOptions, refresh: boolean): Promise<readonly Tool[]> {
    const cached = this.#catalog
    if (!refresh && cached && clock.now() - cached.at < core.CATALOG_TTL_SECONDS) return cached.tools
    if (!this.#pending) {
      this.#pending = this.#fetchCatalog({ timeout: options.timeout }).finally(() => {
        this.#pending = undefined
      })
    }
    return abortable(this.#pending, options.signal)
  }

  async #fetchCatalog(options: RequestOptions): Promise<readonly Tool[]> {
    const payload = await this.getJson('/v1/modules', options)
    if (!Array.isArray(payload)) throw new UnexpectedResponseError('The tool catalog is not a list.')
    const tools = Object.freeze(payload.map(core.toolFromPayload))
    this.#catalog = { at: clock.now(), tools }
    return tools
  }

  async findTool(toolId: string, options: RequestOptions): Promise<Tool | undefined> {
    const found = (await this.catalog(options, false)).find(tool => tool.id === toolId)
    if (found) return found
    return (await this.catalog(options, true)).find(tool => tool.id === toolId)
  }

  runRequest(toolId: string, body: Body, options: RunOptions): Promise<RawResponse> {
    return this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/modules/${toolId}`,
      headers: core.requestHeaders(this.apiKey, 'application/json'),
      maxBytes: core.MAX_JSON_BYTES,
      body,
      timeout: options.timeout,
      readFloor: core.RUN_READ_FLOOR,
      signal: options.signal,
    })
  }

  async openUpload(toolId: string, file: PreparedFile, options: RunOptions): Promise<core.UploadTicket> {
    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/uploads`,
      headers: core.requestHeaders(this.apiKey, 'application/json'),
      maxBytes: core.MAX_JSON_BYTES,
      body: core.uploadRequestBody(toolId, file),
      timeout: options.timeout,
      signal: options.signal,
    })
    let answer = core.uploadAnswer(response, this.apiKey, this.baseUrl)
    while (answer.kind === 'queued') {
      const started = clock.now()
      const queuedId = answer.uploadId
      const status = await this.http.request({
        method: 'GET',
        url: `${this.baseUrl}/v1/uploads/${encodeURIComponent(queuedId)}`,
        headers: core.uploadQueueHeaders(this.apiKey),
        maxBytes: core.MAX_JSON_BYTES,
        timeout: options.timeout,
        readFloor: core.JOB_READ_FLOOR,
        signal: options.signal,
      })
      answer = core.uploadAnswer(status, this.apiKey, this.baseUrl)
      if (answer.uploadId !== queuedId) throw new UnexpectedResponseError('The API answered for another upload.')
      if (answer.kind === 'queued' && clock.now() - started < core.JOB_POLL_PAUSE) {
        await pause(core.JOB_POLL_PAUSE, options.signal)
      }
    }
    return answer
  }

  /** Sends the file to its upload link. False when the link expired and a new one is needed. */
  async putUpload(ticket: core.UploadTicket, file: PreparedFile, options: RunOptions): Promise<boolean> {
    const expired = (): boolean => clock.now() >= ticket.validUntil
    let response: RawResponse
    try {
      response = await this.http.request({
        method: 'PUT',
        url: ticket.url,
        headers: core.linkHeaders(),
        maxBytes: 64 * 1024,
        body: new FileBody(file),
        timeout: options.timeout,
        stop: expired,
        signal: options.signal,
      })
    } catch (error) {
      if (error instanceof APIConnectionError && expired()) return false
      throw error
    }
    if (core.invalidLink(response) || (statusIsRetryable('PUT', response.status) && expired())) return false
    core.checkPut(response, this.apiKey, file)
    return true
  }

  async followJob(jobId: string, options: RunOptions, jobTimeout: number): Promise<RawResponse> {
    const deadline = clock.now() + jobTimeout / 1000
    for (;;) {
      const remaining = deadline - clock.now()
      if (remaining <= 0) throw core.jobTimeoutError(jobId, jobTimeout)
      const started = clock.now()
      const response = await this.http.request({
        method: 'GET',
        url: `${this.baseUrl}/v1/jobs/${jobId}`,
        headers: core.jobHeaders(this.apiKey, remaining),
        maxBytes: core.MAX_JSON_BYTES,
        timeout: options.timeout,
        readFloor: core.JOB_READ_FLOOR,
        signal: options.signal,
      })
      if (core.jobFinished(response, this.apiKey, jobId)) return response
      if (clock.now() - started < core.JOB_POLL_PAUSE) {
        await pause(Math.max(0, Math.min(core.JOB_POLL_PAUSE, deadline - clock.now())), options.signal)
      }
    }
  }

  /** Downloads the outputs, a few at a time. The first failure cancels the others. */
  async downloadAll(links: readonly core.OutputLink[], options: RunOptions): Promise<ToolOutput[]> {
    const stop = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
    const outputs: ToolOutput[] = new Array(links.length)
    let next = 0
    let failure: { error: unknown } | undefined
    const worker = async (): Promise<void> => {
      while (!failure && next < links.length) {
        const index = next++
        const link = links[index]!
        try {
          const response = await this.http.request({
            method: 'GET',
            url: link.url,
            headers: core.linkHeaders(),
            maxBytes: core.limits.maxOutputBytes,
            timeout: options.timeout,
            signal,
          })
          outputs[index] = core.outputFromResponse(link, response, this.apiKey)
        } catch (error) {
          if (!failure) {
            failure = { error }
            stop.abort()
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(core.DOWNLOAD_CONCURRENCY, links.length) }, worker))
    if (failure) throw failure.error
    return outputs
  }
}

export type { Context }
