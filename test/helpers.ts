/** A fake Pixlub API behind a fetch function, and a fake clock. */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach } from 'vitest'

import { Pixlub, type ClientOptions } from '../src/index.js'
import { clock } from '../src/clock.js'
import { limits } from '../src/core.js'

export const API_KEY = 'pix.AbCdEf12.Secret0123456789abcdefghijklmnopqrstuv'
export const BASE_URL = 'https://api.pixlub.test'
export const FILES_HOST = 'files.pixlub.com'

export const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64)])

export const RUN_ID = '0b3e5c2a-1f4d-4e8a-9c71-2d6f8a9b0c1e'
export const JOB_ID = '3c9e5a20-7f41-4b8e-9d2a-6a51f0b4c8e7'
export const JOB_PATH = `/v1/jobs/${JOB_ID}`
export const IMAGE_PATH = `/r/${RUN_ID}_result.png`
export const DATA_PATH = `/r/${RUN_ID}_result.json`
export const IMAGE_LINK = `https://${FILES_HOST}${IMAGE_PATH}?exp=1791848556&sig=signature`
export const DATA_LINK = `https://${FILES_HOST}${DATA_PATH}?exp=1791848556&sig=signature`

type Json = unknown

function input(id: string, required = true, extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    description: `The ${id}.`,
    type: 'image',
    required,
    multiple: false,
    per_file: false,
    max_files: 1,
    accept: ['image/png', 'image/jpeg', 'image/webp'],
    ...extra,
  }
}

export const IMAGE_OUTPUT = {
  key: 'out',
  label: 'Image',
  description: 'The produced image.',
  kind: 'image',
  multiple: false,
  content_types: ['image/png'],
}

export const CATALOG = [
  {
    id: 'removeBgApi',
    name: 'Remove background',
    description: 'Removes the background.',
    category: 'filter',
    executable: true,
    handler: 'remote',
    inputs: [input('image')],
    outputs: [IMAGE_OUTPUT],
  },
  {
    id: 'mask',
    name: 'Mask',
    description: 'Applies a mask.',
    category: 'compose',
    executable: true,
    handler: 'local',
    inputs: [input('image'), input('mask')],
    outputs: [IMAGE_OUTPUT],
  },
  {
    id: 'checker',
    name: 'Checkerboard',
    description: 'Generates a checkerboard.',
    category: 'generate',
    executable: true,
    handler: 'local',
    inputs: [],
    outputs: [IMAGE_OUTPUT],
  },
  {
    id: 'noise',
    name: 'Noise',
    description: 'Adds noise.',
    category: 'generate',
    executable: true,
    handler: 'local',
    inputs: [input('blend', false)],
    outputs: [IMAGE_OUTPUT],
  },
  {
    id: 'collage',
    name: 'Collage',
    description: 'Arranges several images on a background.',
    category: 'compose',
    executable: true,
    handler: 'local',
    inputs: [input('background'), input('tiles', true, { multiple: true, max_files: 4 })],
    outputs: [IMAGE_OUTPUT],
  },
  {
    id: 'flipBatch',
    name: 'Flip (batch)',
    description: 'Each image is a run.',
    category: 'transform',
    executable: true,
    handler: 'local',
    inputs: [input('image', true, { multiple: true, per_file: true, max_files: 10 })],
    outputs: [{ ...IMAGE_OUTPUT, multiple: true }],
  },
  {
    id: 'stack',
    name: 'Stack',
    description: 'Stacks images, with no file limit of its own.',
    category: 'compose',
    executable: true,
    handler: 'local',
    inputs: [input('files', true, { multiple: true, max_files: null })],
    outputs: [IMAGE_OUTPUT],
  },
  {
    id: 'trimVideo',
    name: 'Trim a video',
    description: 'Video only.',
    category: 'transform',
    executable: false,
    handler: 'none',
    inputs: [],
    outputs: [],
  },
]

export function jsonResponse(payload: Json, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function imageResponse(data: Uint8Array = PNG, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': 'image/png', ...headers } })
}

export function errorResponse(status: number, code: string, extra: Record<string, Json> = {}): Response {
  return jsonResponse({ error: `Failure ${code}`, code, ...extra }, status)
}

export function runPayload(outputs?: Json[], extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    id: RUN_ID,
    module: 'removeBgApi',
    outputs: outputs ?? [{ key: 'out', name: 'image', url: IMAGE_LINK, content_type: 'image/png', bytes: PNG.length }],
    expires_at: '2026-10-13T10:00:00Z',
    credits: { cost: 10, balance: 41 },
    ...extra,
  }
}

export function runResponse(outputs?: Json[], extra: Record<string, Json> = {}): Response {
  return jsonResponse(runPayload(outputs, extra))
}

export function accepted(jobId = JOB_ID, module = 'removeBgApi'): Response {
  return jsonResponse(
    { job_id: jobId, module, status: 'running', poll: `https://api.pixlub.com/v1/jobs/${jobId}` },
    202,
    { 'retry-after': '2' },
  )
}

export function job(status: string, extra: Record<string, Json> = {}): Response {
  const payload: Record<string, Json> = {
    job_id: JOB_ID,
    module: 'removeBgApi',
    status,
    created_at: '2026-10-13T09:00:00Z',
  }
  if (status === 'succeeded' || status === 'failed') payload.finished_at = '2026-10-13T09:01:30Z'
  return jsonResponse({ ...payload, ...extra })
}

export function succeeded(extra: Record<string, Json> = {}): Response {
  return jsonResponse({
    ...runPayload(undefined, extra),
    job_id: JOB_ID,
    status: 'succeeded',
    created_at: '2026-10-13T09:00:00Z',
    finished_at: '2026-10-13T09:01:30Z',
  })
}

/** A network failure as fetch reports it: a TypeError whose cause carries the code. */
export function networkError(code: string, syscall?: string): TypeError {
  const cause = Object.assign(new Error(code), { code, ...(syscall ? { syscall } : {}) })
  return new TypeError('fetch failed', { cause })
}

export interface Recorded {
  method: string
  url: URL
  headers: Headers
  body: Buffer
  redirect: RequestRedirect | undefined
}

type Answer = Response | Error | ((request: Recorded) => Response | Promise<Response>)

export class FakeApi {
  readonly requests: Recorded[] = []
  readonly uploaded = new Map<string, Buffer>()
  readonly uploadIds: string[] = []
  readonly #queued = new Map<string, Answer[]>()

  queue(method: string, path: string, ...answers: Answer[]): void {
    const key = `${method} ${path}`
    this.#queued.set(key, [...(this.#queued.get(key) ?? []), ...answers])
  }

  calls(method: string, path: string): Recorded[] {
    return this.requests.filter(request => request.method === method && request.url.pathname === path)
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const url = new URL(input)
    const answer = this.#queued.get(`${method} ${url.pathname}`)?.shift()
    // A connection that fails leaves the body unread, as with a real fetch.
    const read = init.body && !(answer instanceof Error)
    const body = read ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.alloc(0)
    const request: Recorded = { method, url, headers: new Headers(init.headers), body, redirect: init.redirect }
    this.requests.push(request)
    if (answer instanceof Error) throw answer
    const signal = init.signal
    signal?.throwIfAborted()
    const response = Promise.resolve(
      typeof answer === 'function' ? answer(request) : (answer ?? this.#default(request)),
    )
    if (!signal) return response
    // Like a real fetch, an aborted request rejects with the signal's reason.
    return Promise.race([
      response,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
  }

  #default(request: Recorded): Response {
    const { method } = request
    const path = request.url.pathname
    if (method === 'GET' && path === '/v1/modules') return jsonResponse(CATALOG)
    if (method === 'GET' && path.endsWith('/schema')) {
      return jsonResponse({ type: 'object', additionalProperties: false, properties: {} })
    }
    if (method === 'POST' && path === '/v1/uploads') {
      const uploadId = randomUUID()
      this.uploadIds.push(uploadId)
      return jsonResponse(
        {
          upload_id: uploadId,
          upload_url: `https://${FILES_HOST}/u/${uploadId}?exp=1791848556&sig=s`,
          method: 'PUT',
          expires_at: '2099-01-01T00:00:00Z',
        },
        201,
      )
    }
    if (method === 'PUT' && path.startsWith('/u/')) {
      this.uploaded.set(path.slice('/u/'.length), request.body)
      return jsonResponse({ bytes: request.body.length })
    }
    if (method === 'POST' && path.startsWith('/v1/modules/')) return runResponse()
    if (method === 'GET' && path.endsWith('_result.png')) return imageResponse()
    if (method === 'GET' && path.endsWith('_result.json')) return jsonResponse({ faces: [] })
    return jsonResponse({ error: 'Unknown route' }, 404)
  }
}

export interface Part {
  filename: string | undefined
  contentType: string | undefined
  content: Buffer
}

export function parseMultipartAll(request: Recorded): [string, Part][] {
  const contentType = request.headers.get('content-type') ?? ''
  const boundary = contentType.split('boundary=')[1]!.replace(/"/g, '')
  if (Number(request.headers.get('content-length')) !== request.body.length) {
    throw new Error('content-length does not match the body')
  }
  const parts: [string, Part][] = []
  const separator = Buffer.from(`--${boundary}`)
  let rest = request.body
  const chunks: Buffer[] = []
  for (let index = rest.indexOf(separator); index !== -1; index = rest.indexOf(separator)) {
    chunks.push(rest.subarray(0, index))
    rest = rest.subarray(index + separator.length)
  }
  chunks.push(rest)
  for (let chunk of chunks) {
    const textual = chunk.toString('latin1')
    if (textual === '' || textual === '--' || textual === '--\r\n') continue
    if (textual.startsWith('\r\n')) chunk = chunk.subarray(2)
    if (chunk.toString('latin1').endsWith('\r\n')) chunk = chunk.subarray(0, -2)
    const split = chunk.indexOf('\r\n\r\n')
    const head = chunk.subarray(0, split).toString('utf8')
    const content = chunk.subarray(split + 4)
    const name = /name="([^"]*)"/.exec(head)
    const filename = /filename="([^"]*)"/.exec(head)
    const type = /Content-Type: (\S+)/.exec(head)
    parts.push([name![1]!, { filename: filename?.[1], contentType: type?.[1], content }])
  }
  return parts
}

export function parseMultipart(request: Recorded): Record<string, Part> {
  return Object.fromEntries(parseMultipartAll(request))
}

/** Fake time: sleeps return at once and are recorded, in seconds. */
export const fakeTime = { now: 1000, wall: Date.parse('2026-10-13T09:00:00Z') / 1000, waits: [] as number[] }

const realClock = { ...clock }
const realLimits = { ...limits }
const folders: string[] = []

beforeEach(() => {
  fakeTime.now = 1000
  fakeTime.wall = Date.parse('2026-10-13T09:00:00Z') / 1000
  fakeTime.waits = []
  clock.now = () => fakeTime.now
  clock.wallNow = () => fakeTime.wall
  clock.sleep = async (seconds: number, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    fakeTime.waits.push(seconds)
    fakeTime.now += seconds
    fakeTime.wall += seconds
  }
  delete process.env.PIXLUB_API_KEY
  delete process.env.PIXLUB_BASE_URL
})

afterEach(() => {
  Object.assign(clock, realClock)
  Object.assign(limits, realLimits)
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A new temporary folder, removed after the test. */
export function tempDir(): string {
  const folder = mkdtempSync(join(tmpdir(), 'pixlub-test-'))
  folders.push(folder)
  return folder
}

export function makeClient(api: FakeApi, options: ClientOptions = {}): Pixlub {
  return new Pixlub({ apiKey: API_KEY, baseURL: BASE_URL, fetch: api.fetch, ...options })
}

/** Lowers the size above which a run goes through an upload. */
export function smallDirectLimit(limit = 100): number {
  limits.directUploadMaxBytes = limit
  return limit
}
