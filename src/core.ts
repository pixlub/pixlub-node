/** Logic of a run, without network I/O. */

import { clock } from './clock.js'
import { redact, resolveLink } from './config.js'
import {
  APIError,
  type APIErrorFields,
  AuthenticationError,
  ConfigurationError,
  FileTooLargeError,
  InsufficientCreditsError,
  InvalidInputError,
  InvalidRequestError,
  JobTimeoutError,
  NotFoundError,
  PermissionDeniedError,
  type PixlubError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  UnexpectedResponseError,
  UnknownToolError,
} from './errors.js'
import { BytesBody, type ImageSource, type InputValue, MultipartBody, type PreparedFile, SourceURL } from './files.js'
import { jsonObject, type RawResponse, seconds } from './http.js'
import { Tool, type ToolInput, ToolOutput, type ToolOutputSpec, ToolResult } from './models.js'
import { parseRetryAfter } from './retry.js'
import { VERSION } from './version.js'

export const USER_AGENT = `pixlub-node/${VERSION} (Node ${process.versions.node})`

export const DEFAULT_TIMEOUT = 180_000
export const RUN_READ_FLOOR = 70_000
export const JOB_READ_FLOOR = 35_000
export const DEFAULT_JOB_TIMEOUT = 30 * 60_000

export const DIRECT_UPLOAD_MAX_BYTES = 90 * 1024 * 1024
export const MAX_INPUT_FILES = 64
export const MAX_OUTPUTS = MAX_INPUT_FILES * 4
export const MAX_JSON_BYTES = 10 * 1024 * 1024
export const MAX_RETRIES_LIMIT = 5
export const DOWNLOAD_CONCURRENCY = 4
export const CATALOG_TTL_SECONDS = 600

export const JOB_WAIT_SECONDS = 25
export const JOB_POLL_PAUSE = 2
export const UPLOAD_QUEUE_WAIT_SECONDS = 25
export const UPLOAD_LINK_TTL_SECONDS = 15 * 60

/** Limits that tests lower. */
export const limits = {
  directUploadMaxBytes: DIRECT_UPLOAD_MAX_BYTES,
  // Largest output read into memory: above any image the API produces (uploaded
  // images go up to 1 GiB). runOutputBytes: all the outputs of one run together.
  maxOutputBytes: 1024 * 1024 * 1024,
  maxRunOutputBytes: 4 * 1024 * 1024 * 1024,
}

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UPLOAD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const TOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const OUTPUT_NAME_RE = /^[a-z][a-z_]{0,31}$/
const OUTPUT_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_#-]{0,63}$/

export function checkToolId(toolId: unknown): string {
  if (typeof toolId !== 'string' || !TOOL_ID_RE.test(toolId)) {
    throw new InvalidInputError(
      `Invalid tool id ${JSON.stringify(String(toolId).slice(0, 80))}. ` +
        "Ids use letters, digits, '-' and '_', such as 'removeBgApi'.",
    )
  }
  return toolId
}

export function requestHeaders(apiKey: string, accept: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'user-agent': USER_AGENT, accept }
}

/** Headers for links (results, uploads): never the API key. */
export function linkHeaders(): Record<string, string> {
  return { 'user-agent': USER_AGENT, accept: '*/*' }
}

export function toolFromPayload(item: unknown): Tool {
  if (!isObject(item) || typeof item.id !== 'string') {
    throw new UnexpectedResponseError('The tool catalog contains an entry without an id.')
  }
  const inputs: ToolInput[] = (Array.isArray(item.inputs) ? item.inputs : [])
    // Input ids become multipart field names: only plain names are kept.
    .filter((entry): entry is Record<string, unknown> => isObject(entry) && typeof entry.id === 'string' && FIELD_RE.test(entry.id))
    .map(entry => ({
      id: entry.id as string,
      label: text(entry.label),
      required: entry.required === true,
      type: text(entry.type) || 'image',
      description: text(entry.description),
      multiple: entry.multiple === true,
      perFile: entry.per_file === true,
      maxFiles: positiveInt(entry.max_files),
      accept: strings(entry.accept),
    }))
  const outputs: ToolOutputSpec[] = (Array.isArray(item.outputs) ? item.outputs : [])
    .filter((entry): entry is Record<string, unknown> => isObject(entry) && typeof entry.key === 'string')
    .map(entry => ({
      key: entry.key as string,
      label: text(entry.label),
      description: text(entry.description),
      kind: text(entry.kind),
      multiple: entry.multiple === true,
      contentTypes: strings(entry.content_types),
    }))
  return new Tool({
    id: item.id,
    name: text(item.name) || item.id,
    description: text(item.description),
    category: text(item.category),
    executable: item.executable === true,
    handler: text(item.handler) || 'none',
    inputs,
    outputs,
  })
}

export function knownTool(toolId: string, tool: Tool | undefined): Tool {
  if (!tool) {
    throw new UnknownToolError(`'${toolId}' is not in the tool catalog. Call client.tools.list() to see the ids.`)
  }
  return tool
}

export interface RunPlan {
  files: (readonly [string, unknown])[]
  paramsJson: string
  sourceUrl: string | undefined
  primary: string | undefined
}

export function planRun(
  toolId: string,
  tool: Tool,
  options: { image?: InputValue | undefined; inputs?: Record<string, InputValue> | undefined; params?: unknown },
): RunPlan {
  if (!tool.executable) throw new InvalidInputError(`'${toolId}' cannot be run through the API.`)
  const { image, inputs, params } = options
  if (image !== undefined && inputs !== undefined) {
    throw new InvalidInputError('Pass either image or inputs, not both.')
  }

  let named: [string, unknown[]][]
  if (image !== undefined) {
    named = [[singleImageInput(tool), asList('image', image)]]
  } else if (inputs !== undefined) {
    named = namedInputs(toolId, tool, inputs)
  } else {
    named = []
    const required = tool.inputs.filter(input => input.required).map(input => input.id)
    if (required.length) {
      throw new InvalidInputError(`'${toolId}' needs a file for: ${required.join(', ')}. Pass image or inputs.`)
    }
  }

  let primary = tool.primaryInput?.id
  const files: (readonly [string, unknown])[] = []
  let sourceUrl: string | undefined
  const specs = new Map(tool.inputs.map(input => [input.id, input]))
  for (const [name, values] of named) {
    const urls = values.filter((value): value is SourceURL => value instanceof SourceURL)
    if (urls.length) {
      if (values.length !== 1 || sourceUrl !== undefined) {
        throw new InvalidInputError('A run takes one SourceURL, alone in its input.')
      }
      if (name !== primary) {
        throw new InvalidInputError(`A SourceURL can only fill '${primary}', the main input of '${toolId}'.`)
      }
      sourceUrl = urls[0]!.url
      primary = name
      continue
    }
    const spec = specs.get(name)!
    if (!spec.multiple && values.length > 1) {
      throw new InvalidInputError(`Input '${name}' of '${toolId}' takes one file, not a list.`)
    }
    if (spec.maxFiles !== undefined && values.length > spec.maxFiles) {
      throw new InvalidInputError(`Input '${name}' of '${toolId}' takes at most ${spec.maxFiles} files.`)
    }
    for (const value of values) files.push([name, value])
  }

  if (files.length > MAX_INPUT_FILES) throw new InvalidInputError(`A run sends at most ${MAX_INPUT_FILES} files.`)
  return { files, paramsJson: encodeParams(params), sourceUrl, primary }
}

function asList(label: string, value: InputValue): ImageSource[] {
  // Only arrays hold several files: a Buffer is a list of bytes, not of files.
  if (Array.isArray(value)) {
    if (!value.length) throw new InvalidInputError(`${label} got an empty list.`)
    return [...(value as ImageSource[])]
  }
  return [value as ImageSource]
}

function singleImageInput(tool: Tool): string {
  if (!tool.inputs.length) {
    throw new InvalidInputError(`'${tool.id}' takes no image. Pass its settings with params only.`)
  }
  const required = tool.inputs.filter(input => input.required)
  const candidates = required.length ? required : tool.inputs
  if (candidates.length === 1) return candidates[0]!.id
  const names = tool.inputs.map(input => input.id).join(', ')
  throw new InvalidInputError(`'${tool.id}' takes several images (${names}). Pass inputs: { '<name>': image, ... }.`)
}

function namedInputs(toolId: string, tool: Tool, inputs: unknown): [string, unknown[]][] {
  if (!isObject(inputs) || inputs instanceof Map || !Object.keys(inputs).length) {
    throw new InvalidInputError("inputs must be a non-empty object such as { image: 'photo.png' }.")
  }
  const known = new Set(tool.inputs.map(input => input.id))
  const named: [string, unknown[]][] = []
  for (const [name, value] of Object.entries(inputs)) {
    if (!FIELD_RE.test(name)) throw new InvalidInputError(`Invalid input name ${JSON.stringify(name.slice(0, 80))}.`)
    if (!known.has(name)) {
      const available = [...known].sort().join(', ') || 'none'
      throw new InvalidInputError(`'${toolId}' has no input named '${name}'. Its inputs are: ${available}.`)
    }
    if (value === undefined || value === null) throw new InvalidInputError(`Input '${name}' has no file.`)
    named.push([name, asList(`Input '${name}'`, value as InputValue)])
  }
  const missing = tool.inputs.filter(input => input.required && !(input.id in inputs)).map(input => input.id)
  if (missing.length) {
    throw new InvalidInputError(`'${toolId}' is missing required input(s): ${missing.join(', ')}.`)
  }
  return named
}

export function encodeParams(params: unknown): string {
  if (params === undefined || params === null) return '{}'
  if (!isPlainObject(params)) throw new InvalidInputError("params must be an object such as { width: 512 }.")
  const problem = jsonProblem(params, 0, new Set())
  if (problem) throw new InvalidInputError(`params must contain only JSON values: ${problem}.`)
  return JSON.stringify(params)
}

/** Why a value would not survive JSON.stringify unchanged, if it would not. */
function jsonProblem(value: unknown, depth: number, parents: Set<object>): string | undefined {
  if (depth > 64) return 'it is nested too deeply'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `${value} is not a JSON number`
  if (typeof value !== 'object') return `a ${typeof value} is not a JSON value`
  if (parents.has(value)) return 'it contains a circular reference'
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return `a ${value.constructor?.name ?? 'object'} is not a JSON value`
  }
  parents.add(value)
  try {
    const items = Array.isArray(value) ? value : Object.values(value)
    for (const item of items) {
      const problem = jsonProblem(item, depth + 1, parents)
      if (problem) return problem
    }
  } finally {
    parents.delete(value)
  }
  return undefined
}

export interface Transport {
  upload: PreparedFile | undefined
  direct: PreparedFile[]
}

export function planTransport(
  plan: RunPlan,
  files: readonly PreparedFile[],
  options: { forceUpload?: boolean; directLimit?: number | undefined } = {},
): Transport {
  const limit =
    options.directLimit === undefined
      ? limits.directUploadMaxBytes
      : Math.min(options.directLimit, limits.directUploadMaxBytes)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= limit && !options.forceUpload) return { upload: undefined, direct: [...files] }

  const tooMuch = `The files of this run total ${total} bytes, more than the ${limit} bytes one request can carry`
  if (plan.sourceUrl !== undefined) {
    throw new InvalidInputError(`${tooMuch}. The SourceURL fills the main input, so the other files must fit.`)
  }
  if (plan.primary === undefined) {
    throw new InvalidInputError(
      `${tooMuch}, and this tool has no main input, so none can be uploaded on its own. Send a smaller file.`,
    )
  }
  const mine = files.filter(file => file.formName === plan.primary)
  const others = files.filter(file => file.formName !== plan.primary)
  if (!mine.length) {
    throw new InvalidInputError(`${tooMuch}. Only the main input, '${plan.primary}', can be uploaded on its own.`)
  }
  if (mine.length > 1) {
    throw new InvalidInputError(
      `${tooMuch}. An upload carries one file, and '${plan.primary}' got ${mine.length}: split them into several runs.`,
    )
  }
  const rest = others.reduce((sum, file) => sum + file.size, 0)
  if (rest > limit) {
    throw new InvalidInputError(
      `${tooMuch}. Even with '${plan.primary}' uploaded on its own, the other inputs total ${rest} bytes.`,
    )
  }
  return { upload: mine[0], direct: others }
}

export function runBody(plan: RunPlan, files: readonly PreparedFile[], uploadId?: string): MultipartBody {
  const fields: [string, string][] = [['params', plan.paramsJson]]
  if (uploadId !== undefined) fields.push(['upload_id', uploadId])
  else if (plan.sourceUrl !== undefined) fields.push(['source_url', plan.sourceUrl])
  return new MultipartBody(fields, files)
}

export function uploadRequestBody(toolId: string, file: PreparedFile): BytesBody {
  const payload = { module: toolId, filename: file.filename, bytes: file.size }
  return new BytesBody(Buffer.from(JSON.stringify(payload)), 'application/json')
}

/** The direct limit to use (0 when not given) when a run is refused with `use_uploads`. */
export function wantsUpload(response: RawResponse): number | undefined {
  const payload = response.status === 413 ? jsonObject(response.body) : undefined
  if (payload?.code !== 'use_uploads') return undefined
  return positiveInt(payload.max_bytes) ?? 0
}

export function uploadIncomplete(response: RawResponse): boolean {
  return response.status === 409 && jsonObject(response.body)?.code === 'upload_incomplete'
}

export function invalidLink(response: RawResponse): boolean {
  return response.status === 403 && jsonObject(response.body)?.code === 'invalid_link'
}

export interface UploadTicket {
  kind: 'ticket'
  uploadId: string
  url: string
  /** Monotonic time (clock.now) after which the link is no longer valid. */
  validUntil: number
}

export interface UploadQueued {
  kind: 'queued'
  uploadId: string
  position: number
}

export function uploadAnswer(response: RawResponse, apiKey: string, baseUrl: string): UploadTicket | UploadQueued {
  const payload = jsonBody(response, apiKey)
  if (!isObject(payload)) throw new UnexpectedResponseError('The upload answer is not a JSON object.')
  const uploadId = payload.upload_id
  if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) {
    throw new UnexpectedResponseError('The upload answer has no valid upload id.')
  }
  if (payload.status === 'queued') {
    return { kind: 'queued', uploadId, position: positiveInt(payload.position) ?? 0 }
  }
  const method = payload.method ?? 'PUT'
  if (typeof method !== 'string' || method.toUpperCase() !== 'PUT') {
    throw new UnexpectedResponseError('The upload answer asks for a method other than PUT.')
  }
  let url: string
  try {
    url = resolveLink(payload.upload_url, baseUrl)
  } catch (error) {
    throw new UnexpectedResponseError(`Refused an upload link: ${(error as Error).message}.`)
  }
  return {
    kind: 'ticket',
    uploadId,
    url,
    validUntil: clock.now() + linkLifetime(payload.expires_at, response.headers.get('date')),
  }
}

/**
 * Seconds the link stays valid: at most 15 minutes, measured against the server's
 * clock when it sent a Date header, so a wrong local clock does not matter.
 */
function linkLifetime(expiresAt: unknown, date: string | null): number {
  const expires = parseTimestamp(expiresAt)
  if (expires === undefined) return UPLOAD_LINK_TTL_SECONDS
  const serverNow = date ? Date.parse(date) / 1000 : Number.NaN
  const now = Number.isFinite(serverNow) ? serverNow : clock.wallNow()
  return Math.min(Math.max(expires - now, 0), UPLOAD_LINK_TTL_SECONDS)
}

export function uploadQueueHeaders(apiKey: string): Record<string, string> {
  return { ...requestHeaders(apiKey, 'application/json'), prefer: `wait=${UPLOAD_QUEUE_WAIT_SECONDS}` }
}

/** Seconds since the epoch, from an ISO 8601 date with a time zone (UTC when it has none). */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim())
  if (!match) return undefined
  const [, day, time, fraction = '', zone = 'Z'] = match
  const when = Date.parse(`${day}T${time}${fraction.slice(0, 4)}${zone.toUpperCase()}`)
  return Number.isNaN(when) ? undefined : when / 1000
}

export function errorFromResponse(response: RawResponse, apiKey: string, suffix = ''): APIError {
  const payload = response.body.byteLength <= 64 * 1024 ? jsonObject(response.body) : undefined
  let message: string | undefined
  for (const key of ['message', 'error']) {
    const value = payload?.[key]
    if (typeof value === 'string' && value.trim()) {
      message = value.trim()
      break
    }
  }
  const code = typeof payload?.code === 'string' ? clean(payload.code).slice(0, 64) : undefined
  const status = response.status
  const body = payload ?? {}
  const textMessage = redact(clean(message ?? `The Pixlub API returned HTTP ${status}.`), apiKey).slice(0, 500)

  const fields: APIErrorFields = {
    httpStatus: status,
    code,
    details: payload?.details,
    body: payload,
    retryAfter: parseRetryAfterOrBody(response, body),
    maxBytes: positiveInt(body.max_bytes),
    maxPixels: positiveInt(body.max_pixels),
    limit: asInt(body.limit),
    requiredCredits: asInt(body.required),
    resetAt: typeof body.reset_at === 'string' ? body.reset_at.slice(0, 64) : undefined,
  }
  return new (errorClass(status))(`${textMessage}${suffix}`, fields)
}

function errorClass(status: number): new (message: string, fields: APIErrorFields) => APIError {
  if (status === 401) return AuthenticationError
  if (status === 402) return InsufficientCreditsError
  if (status === 403) return PermissionDeniedError
  if (status === 404) return NotFoundError
  if (status === 413) return FileTooLargeError
  if (status === 429) return RateLimitError
  if (status >= 400 && status < 500) return InvalidRequestError
  if (status === 503) return ServiceUnavailableError
  if (status >= 500 && status < 600) return ServerError
  return APIError
}

function parseRetryAfterOrBody(response: RawResponse, body: Record<string, unknown>): number | undefined {
  return parseRetryAfter(response.headers.get('retry-after')) ?? seconds(body.retry_after)
}

export function jsonBody(response: RawResponse, apiKey: string): unknown {
  if (response.tooLarge) throw new UnexpectedResponseError('The API returned more data than the SDK accepts.')
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, apiKey)
  try {
    return JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new UnexpectedResponseError('The API returned a body that is not valid JSON.')
  }
}

/** Checks the answer to an upload PUT, including the size the server says it received. */
export function checkPut(response: RawResponse, apiKey: string, file: PreparedFile): void {
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, apiKey)
  const received = response.tooLarge ? undefined : jsonObject(response.body)?.bytes
  if (typeof received === 'number' && received !== file.size) {
    throw new UnexpectedResponseError(
      `The upload server received ${received} bytes of input '${file.formName}', not ${file.size}.`,
    )
  }
}

export function acceptedJobId(response: RawResponse, apiKey: string): string {
  const payload = jsonBody(response, apiKey)
  const jobId = isObject(payload) ? payload.job_id : undefined
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new UnexpectedResponseError('The API accepted the run without a job id to follow.')
  }
  return jobId
}

export function jobHeaders(apiKey: string, remainingSeconds: number): Record<string, string> {
  const wait = Math.max(1, Math.min(JOB_WAIT_SECONDS, Math.ceil(remainingSeconds)))
  return { ...requestHeaders(apiKey, 'application/json'), prefer: `wait=${wait}` }
}

export function jobFinished(response: RawResponse, apiKey: string, jobId: string): boolean {
  const payload = jsonBody(response, apiKey)
  if (!isObject(payload)) throw new UnexpectedResponseError('The job answer is not a JSON object.')
  const status = payload.status
  if (status === 'succeeded') return true
  if (status === 'queued' || status === 'running') return false
  if (status === 'failed') {
    const given = asInt(payload.http_status)
    const httpStatus = given !== undefined && given >= 400 && given < 600 ? given : 500
    const error = errorFromResponse({ ...response, status: httpStatus }, apiKey, ` (job ${jobId})`)
    error.jobId = jobId
    throw error
  }
  throw new UnexpectedResponseError('The job answer has an unknown status.')
}

export function jobTimeoutError(jobId: string, timeoutMs: number): JobTimeoutError {
  return new JobTimeoutError(
    `Job ${jobId} was still running after ${timeoutMs / 1000} s (jobTimeout). It was accepted, ` +
      'so its credits may have been charged, and it may still finish: follow it with ' +
      `GET /v1/jobs/${jobId} rather than running the tool again.`,
    { jobId },
  )
}

/** Adds to an error what the caller must know once a run was accepted or charged. */
export function afterAcceptance(
  error: PixlubError,
  ids: { jobId?: string | undefined; runId?: string | undefined },
): void {
  let note: string
  if (ids.jobId !== undefined) {
    error.jobId = ids.jobId
    note =
      `Job ${ids.jobId} was accepted, so its credits may have been charged: follow it with ` +
      `GET /v1/jobs/${ids.jobId} before running the tool again.`
  } else {
    const which = ids.runId ? `Run ${ids.runId}` : 'The run'
    note = `${which} succeeded and was charged: do not run it again to get its result.`
  }
  error.message = `${error.message} ${note}`.trim()
}

export interface OutputLink {
  key: string
  name: string
  url: string
  contentType: string
  bytes: number | undefined
}

export interface RunReceipt {
  module: string
  outputs: OutputLink[]
  id: string | undefined
  expiresAt: string | undefined
  cost: number | undefined
  creditsBalance: number | undefined
  message: string | undefined
}

export function receiptFromResponse(response: RawResponse, apiKey: string, baseUrl: string): RunReceipt {
  const payload = jsonBody(response, apiKey)
  if (!isObject(payload)) throw new UnexpectedResponseError('The run response is not a JSON object.')

  const rawOutputs = payload.outputs
  if (!Array.isArray(rawOutputs) || !rawOutputs.length) {
    throw new UnexpectedResponseError('The run response lists no output.')
  }
  if (rawOutputs.length > MAX_OUTPUTS) {
    throw new UnexpectedResponseError(
      `The run response lists ${rawOutputs.length} outputs; the SDK reads at most ${MAX_OUTPUTS}.`,
    )
  }
  const outputs: OutputLink[] = rawOutputs.map(entry => {
    if (!isObject(entry) || typeof entry.url !== 'string') {
      throw new UnexpectedResponseError('The run response contains an output without a link.')
    }
    let url: string
    try {
      url = resolveLink(entry.url, baseUrl)
    } catch (error) {
      throw new UnexpectedResponseError(`Refused a result link: ${(error as Error).message}.`)
    }
    const name = text(entry.name)
    const key = text(entry.key)
    const bytes = asInt(entry.bytes)
    return {
      name: OUTPUT_NAME_RE.test(name) ? name : 'file',
      url,
      contentType: contentTypeOf(text(entry.content_type)) || 'application/octet-stream',
      key: OUTPUT_KEY_RE.test(key) ? key : '',
      bytes: bytes !== undefined && bytes >= 0 ? bytes : undefined,
    }
  })

  // Announced sizes are checked before anything is downloaded.
  for (const link of outputs) {
    if (link.bytes !== undefined && link.bytes > limits.maxOutputBytes) {
      throw new UnexpectedResponseError(
        `One of its files is ${link.bytes} bytes, more than the ${limits.maxOutputBytes} bytes ` +
          'the SDK downloads: get it from its link instead.',
      )
    }
  }
  if (outputs.reduce((sum, link) => sum + (link.bytes ?? 0), 0) > limits.maxRunOutputBytes) {
    throw new UnexpectedResponseError('Its results are larger than the SDK accepts.')
  }

  const credits = isObject(payload.credits) ? payload.credits : {}
  return {
    module: text(payload.module),
    outputs,
    id: typeof payload.id === 'string' ? payload.id.slice(0, 128) : undefined,
    expiresAt: typeof payload.expires_at === 'string' ? payload.expires_at.slice(0, 64) : undefined,
    cost: asInt(credits.cost),
    creditsBalance: asInt(credits.balance),
    message: typeof payload.message === 'string' ? payload.message.slice(0, 1000) : undefined,
  }
}

export function runIdOf(response: RawResponse): string | undefined {
  const runId = jsonObject(response.body)?.id
  return typeof runId === 'string' && runId ? runId.slice(0, 128) : undefined
}

export function outputFromResponse(link: OutputLink, response: RawResponse, apiKey: string): ToolOutput {
  if (response.tooLarge) {
    throw new UnexpectedResponseError(
      `The tool output is larger than ${limits.maxOutputBytes} bytes and was not read.`,
    )
  }
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, apiKey)
  return new ToolOutput({
    key: link.key,
    name: link.name,
    url: link.url,
    contentType: contentTypeOf(response.headers.get('content-type') ?? '') || link.contentType,
    content: response.body,
    bytes: link.bytes,
  })
}

export function toolResult(receipt: RunReceipt, outputs: ToolOutput[]): ToolResult {
  return new ToolResult({
    module: receipt.module,
    outputs,
    id: receipt.id,
    expiresAt: receipt.expiresAt,
    cost: receipt.cost,
    creditsBalance: receipt.creditsBalance,
    message: receipt.message,
  })
}

export function checkTimeout(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 2 ** 31 - 1) {
    return value
  }
  throw new ConfigurationError(`${name} must be a positive number of milliseconds.`)
}

export function checkRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_RETRIES_LIMIT) {
    throw new ConfigurationError(`maxRetries must be an integer from 0 to ${MAX_RETRIES_LIMIT}.`)
  }
  return value
}

export function checkPositive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer.`)
  }
  return value
}

function contentTypeOf(header: string): string {
  return (header.split(';', 1)[0] ?? '').trim().toLowerCase().slice(0, 128)
}

/** Control characters from the server become spaces, so a message cannot fake log lines. */
function clean(value: string): string {
  return value.replace(/[\p{Cc}]/gu, ' ')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function positiveInt(value: unknown): number | undefined {
  const number = asInt(value)
  return number !== undefined && number > 0 ? number : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
