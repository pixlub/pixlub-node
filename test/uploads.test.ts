import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  FileTooLargeError,
  InvalidInputError,
  InvalidRequestError,
  NotFoundError,
  ServerError,
  SourceURL,
} from '../src/index.js'
import { DIRECT_UPLOAD_MAX_BYTES, limits } from '../src/core.js'
import {
  API_KEY,
  errorResponse,
  FakeApi,
  fakeTime,
  FILES_HOST,
  jsonResponse,
  makeClient,
  networkError,
  parseMultipart,
  PNG,
  smallDirectLimit,
  tempDir,
} from './helpers.js'

const RUN = '/v1/modules/removeBgApi'
const BIG = Buffer.concat([PNG, Buffer.alloc(200, 7)])
const UPLOAD_A = 'up_a1b2c3'
const UPLOAD_B = 'up_d4e5f6'

function bigFile(): string {
  const path = join(tempDir(), 'big.png')
  writeFileSync(path, BIG)
  return path
}

function ticket(uploadId: string, expiresAt = '2099-01-01T00:00:00Z', headers: Record<string, string> = {}) {
  return jsonResponse(
    { upload_id: uploadId, upload_url: `https://${FILES_HOST}/u/${uploadId}?sig=s`, method: 'PUT', expires_at: expiresAt },
    201,
    headers,
  )
}

function queued(uploadId: string, position: number) {
  return jsonResponse({ upload_id: uploadId, status: 'queued', position }, 202)
}

describe('direct or upload', () => {
  it('sends small files directly', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(api.calls('POST', '/v1/uploads')).toEqual([])
    expect(parseMultipart(api.calls('POST', RUN)[0]!).image!.content).toEqual(PNG)
  })

  it('keeps the contract direct limit', () => {
    expect(DIRECT_UPLOAD_MAX_BYTES).toBe(94_371_840)
    expect(limits.directUploadMaxBytes).toBe(94_371_840)
  })

  it('uploads a large file, then runs it by its id', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    const result = await makeClient(api).tools.run('removeBgApi', { image: bigFile() })

    expect(result.image).toEqual(PNG)
    const [opened] = api.calls('POST', '/v1/uploads')
    expect(opened!.headers.get('x-api-key')).toBe(API_KEY)
    expect(opened!.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(opened!.body.toString())).toEqual({ module: 'removeBgApi', filename: 'big.png', bytes: BIG.length })

    const uploadId = api.uploadIds[0]!
    const [put] = api.calls('PUT', `/u/${uploadId}`)
    expect(put!.url.host).toBe(FILES_HOST)
    expect(put!.headers.get('x-api-key')).toBeNull()
    expect(put!.url.href).not.toContain(API_KEY)
    expect(put!.headers.get('content-length')).toBe(String(BIG.length))
    expect(put!.headers.get('content-type')).toBe('image/png')
    expect(put!.redirect).toBe('manual')
    expect(api.uploaded.get(uploadId)).toEqual(BIG)

    const fields = parseMultipart(api.calls('POST', RUN)[0]!)
    expect(Object.keys(fields)).toEqual(['params', 'upload_id'])
    expect(fields.upload_id!.content.toString()).toBe(uploadId)
    const order = api.requests.filter(r => r.url.pathname !== '/v1/modules').map(r => `${r.method} ${r.url.pathname}`)
    expect(order.slice(0, 3)).toEqual(['POST /v1/uploads', `PUT /u/${uploadId}`, `POST ${RUN}`])
  })

  it('keeps the other inputs in the run request', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    await makeClient(api).tools.run('mask', { inputs: { image: bigFile(), mask: PNG } })
    const fields = parseMultipart(api.calls('POST', '/v1/modules/mask')[0]!)
    expect(Object.keys(fields)).toEqual(['params', 'upload_id', 'mask'])
    expect(fields.mask!.content).toEqual(PNG)
    expect([...api.uploaded.values()]).toEqual([BIG])
  })

  it('uploads a stream whole, from a spooled copy', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    await makeClient(api).tools.run('removeBgApi', { image: Readable.from([BIG.subarray(0, 50), BIG.subarray(50)]) })
    expect([...api.uploaded.values()]).toEqual([BIG])
  })

  it('uploads bytes and Blobs', async () => {
    smallDirectLimit()
    for (const source of [BIG, new Blob([BIG]), new Uint8Array(BIG).buffer]) {
      const api = new FakeApi()
      await makeClient(api).tools.run('removeBgApi', { image: source })
      expect([...api.uploaded.values()]).toEqual([BIG])
    }
  })

  it.each([
    [{ inputs: { image: PNG, mask: BIG } }, /uploaded on its own, the other inputs total 272 bytes/],
    [{ inputs: { image: new SourceURL('https://example.com/a.png'), mask: BIG } }, /SourceURL fills the main input/],
    [{ inputs: { image: BIG, mask: BIG } }, /other inputs total 272 bytes/],
  ])('refuses locally a run that fits no way (%#)', async (options, message) => {
    smallDirectLimit()
    const api = new FakeApi()
    await expect(makeClient(api).tools.run('mask', options as never)).rejects.toThrow(message)
    expect(api.requests.filter(r => r.method !== 'GET')).toEqual([])
  })

  it('refuses locally several large files in the main input', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    await expect(makeClient(api).tools.run('flipBatch', { image: [BIG, BIG] })).rejects.toThrow(/split them/)
    await expect(makeClient(api).tools.run('noise', { inputs: { blend: BIG } })).resolves.toBeDefined()
  })
})

describe('upload link', () => {
  it('retries the PUT on server and network errors', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A))
    api.queue('PUT', `/u/${UPLOAD_A}`, errorResponse(507, 'storage_full'), networkError('ECONNRESET'))
    await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    expect(api.calls('PUT', `/u/${UPLOAD_A}`)).toHaveLength(3)
    expect(api.uploaded.get(UPLOAD_A)).toEqual(BIG)
  })

  it('gives up the PUT after the retries', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A))
    api.queue('PUT', `/u/${UPLOAD_A}`, ...[1, 2, 3].map(() => errorResponse(502, 'bad_gateway')))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(ServerError)
    expect(api.calls('PUT', `/u/${UPLOAD_A}`)).toHaveLength(3)
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('does not retry a PUT refused as too large', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A))
    api.queue('PUT', `/u/${UPLOAD_A}`, errorResponse(413, 'too_large'))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(FileTooLargeError)
    expect(api.calls('PUT', `/u/${UPLOAD_A}`)).toHaveLength(1)
  })

  it('refuses an upload the server received incompletely', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A))
    api.queue('PUT', `/u/${UPLOAD_A}`, jsonResponse({ bytes: 12 }))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(
      /received 12 bytes of input 'image', not 272/,
    )
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('opens one new upload when the link expired', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A), ticket(UPLOAD_B))
    api.queue('PUT', `/u/${UPLOAD_A}`, errorResponse(403, 'invalid_link'))
    await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(2)
    expect([...api.uploaded.keys()]).toEqual([UPLOAD_B])
    expect(parseMultipart(api.calls('POST', RUN)[0]!).upload_id!.content.toString()).toBe(UPLOAD_B)
  })

  it('stops after two expired links in a row', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A), ticket(UPLOAD_B))
    api.queue('PUT', `/u/${UPLOAD_A}`, errorResponse(403, 'invalid_link'))
    api.queue('PUT', `/u/${UPLOAD_B}`, errorResponse(403, 'invalid_link'))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(
      /expired twice in a row/,
    )
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(2)
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('does not retry a link past its expiry', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A, '2001-01-01T00:00:00Z'))
    api.queue('PUT', `/u/${UPLOAD_A}`, errorResponse(503, 'unavailable'))
    await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    expect(api.calls('PUT', `/u/${UPLOAD_A}`)).toHaveLength(1)
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(2)
  })

  it('measures the link lifetime against the server clock', async () => {
    smallDirectLimit()
    fakeTime.wall = Date.parse('2030-01-01T00:00:00Z') / 1000 // a local clock far ahead
    const api = new FakeApi()
    const date = 'Tue, 13 Oct 2026 09:00:00 GMT'
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A, '2026-10-13T09:15:00Z', { date }))
    api.queue('PUT', `/u/${UPLOAD_A}`, errorResponse(503, 'unavailable'))
    await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    expect(api.calls('PUT', `/u/${UPLOAD_A}`)).toHaveLength(2)
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(1)
  })

  it('follows no redirect on the PUT', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', ticket(UPLOAD_A))
    api.queue('PUT', `/u/${UPLOAD_A}`, new Response(null, { status: 307, headers: { location: 'https://attacker.test/' } }))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: bigFile() }))
    expect(error).toBeInstanceOf(APIError)
    expect(api.requests.map(r => r.url.host)).not.toContain('attacker.test')
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it.each([
    'http://files.pixlub.com/u/x',
    'https://user:pw@files.pixlub.com/u/x',
    'ftp://files.pixlub.com/u/x',
  ])('never uses the unsafe upload link %s', async link => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', jsonResponse({ upload_id: UPLOAD_A, upload_url: link, method: 'PUT' }, 201))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(/Refused an upload link/)
    expect(api.requests.filter(r => r.method === 'PUT')).toEqual([])
  })

  it.each([
    [{ upload_id: '../x', upload_url: 'https://files.pixlub.com/u/x' }, /no valid upload id/],
    [{ upload_id: UPLOAD_A, upload_url: 'https://files.pixlub.com/u/x', method: 'POST' }, /other than PUT/],
  ])('refuses a strange upload answer (%#)', async (payload, message) => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', jsonResponse(payload, 201))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(message)
  })

  it('retries opening an upload on 429 only', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', jsonResponse({ error: 'slow' }, 429, { 'retry-after': '1' }))
    await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(2)

    const failing = new FakeApi()
    failing.queue('POST', '/v1/uploads', errorResponse(500, 'boom'))
    await expect(makeClient(failing).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(ServerError)
    expect(failing.calls('POST', '/v1/uploads')).toHaveLength(1)
  })

  it('exposes the limit of a size refused on opening', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', errorResponse(413, 'file_too_large', { max_bytes: 104857600 }))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: bigFile() }))
    expect(error).toBeInstanceOf(FileTooLargeError)
    expect(error).toMatchObject({ maxBytes: 104857600, code: 'file_too_large' })
  })
})

describe('upload queue', () => {
  it('follows a queued upload until its link', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', queued(UPLOAD_A, 2))
    api.queue('GET', `/v1/uploads/${UPLOAD_A}`, queued(UPLOAD_A, 1), ticket(UPLOAD_A))
    const result = await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    expect(result.image).toEqual(PNG)
    const follows = api.calls('GET', `/v1/uploads/${UPLOAD_A}`)
    expect(follows).toHaveLength(2)
    for (const follow of follows) {
      expect(follow.headers.get('x-api-key')).toBe(API_KEY)
      expect(follow.headers.get('prefer')).toBe('wait=25')
    }
    expect(fakeTime.waits).toEqual([2])
    expect(api.uploaded.get(UPLOAD_A)).toEqual(BIG)
  })

  it('fails when a queued upload is given up', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', queued(UPLOAD_A, 1))
    api.queue('GET', `/v1/uploads/${UPLOAD_A}`, errorResponse(404, 'upload_not_found'))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(NotFoundError)
    expect(api.requests.filter(r => r.method === 'PUT')).toEqual([])
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('refuses a queue answer for another upload', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', queued(UPLOAD_A, 1))
    api.queue('GET', `/v1/uploads/${UPLOAD_A}`, ticket(UPLOAD_B))
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(/another upload/)
    expect(api.requests.filter(r => r.method === 'PUT')).toEqual([])
  })
})

describe('run of an upload', () => {
  it('retries upload_incomplete with growing pauses', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', RUN, errorResponse(409, 'upload_incomplete'), errorResponse(409, 'upload_incomplete'))
    const result = await makeClient(api, { maxRetries: 0 }).tools.run('removeBgApi', { image: bigFile() })
    expect(result.image).toEqual(PNG)
    const runs = api.calls('POST', RUN)
    expect(runs).toHaveLength(3)
    expect(new Set(runs.map(r => parseMultipart(r).upload_id!.content.toString()))).toEqual(new Set([api.uploadIds[0]]))
    expect(fakeTime.waits).toEqual([1, 2])
  })

  it('gives up upload_incomplete after five tries', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', RUN, ...Array.from({ length: 6 }, () => errorResponse(409, 'upload_incomplete')))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: bigFile() }))
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect(error).toMatchObject({ code: 'upload_incomplete' })
    expect(api.calls('POST', RUN)).toHaveLength(5)
    expect(fakeTime.waits).toEqual([1, 2, 4, 8])
  })

  it.each([
    [() => errorResponse(500, 'boom'), ServerError],
    [() => errorResponse(404, 'upload_not_found'), NotFoundError],
    [() => networkError('UND_ERR_HEADERS_TIMEOUT'), APITimeoutError],
    [() => networkError('ECONNRESET'), APIConnectionError],
    [() => errorResponse(409, 'something_else'), InvalidRequestError],
  ] as const)('never sends an upload id twice after other answers (%#)', async (answer, kind) => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', RUN, answer())
    await expect(makeClient(api).tools.run('removeBgApi', { image: bigFile() })).rejects.toThrow(kind)
    expect(api.calls('POST', RUN)).toHaveLength(1)
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(1)
  })

  it('keeps the upload id through a 429 on the run', async () => {
    smallDirectLimit()
    const api = new FakeApi()
    api.queue('POST', RUN, jsonResponse({ error: 'slow' }, 429, { 'retry-after': '1' }))
    await makeClient(api).tools.run('removeBgApi', { image: bigFile() })
    const [first, second] = api.calls('POST', RUN)
    expect(parseMultipart(first!).upload_id).toEqual(parseMultipart(second!).upload_id)
  })

  it('switches to an upload once on 413 use_uploads', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, errorResponse(413, 'use_uploads', { max_bytes: 94371840 }))
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.image).toEqual(PNG)
    const [first, second] = api.calls('POST', RUN)
    expect(Object.keys(parseMultipart(first!))).toContain('image')
    expect(Object.keys(parseMultipart(second!))).toEqual(['params', 'upload_id'])
    expect(api.calls('POST', '/v1/uploads')).toHaveLength(1)
    expect([...api.uploaded.values()]).toEqual([PNG])
  })

  it('raises a second 413', async () => {
    const api = new FakeApi()
    api.queue(
      'POST',
      '/v1/modules/mask',
      errorResponse(413, 'use_uploads', { max_bytes: 100 }),
      errorResponse(413, 'use_uploads', { max_bytes: 100 }),
    )
    const error = await capture(makeClient(api).tools.run('mask', { inputs: { image: PNG, mask: PNG } }))
    expect(error).toBeInstanceOf(FileTooLargeError)
    expect(api.calls('POST', '/v1/modules/mask')).toHaveLength(2)
  })

  it('raises a 413 use_uploads that no upload can solve', async () => {
    const api = new FakeApi()
    api.queue('POST', '/v1/modules/mask', errorResponse(413, 'use_uploads', { max_bytes: 10 }))
    const error = await capture(makeClient(api).tools.run('mask', { inputs: { image: PNG, mask: PNG } }))
    expect(error).toBeInstanceOf(FileTooLargeError)
    expect(error).toMatchObject({ code: 'use_uploads', maxBytes: 10 })
    expect(api.calls('POST', '/v1/uploads')).toEqual([])
  })
})

describe('file counts', () => {
  it('checks them locally', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    await expect(client.tools.run('flipBatch', { image: Array(11).fill(PNG) })).rejects.toThrow(/at most 10 files/)
    await expect(client.tools.run('stack', { inputs: { files: Array(65).fill(PNG) } })).rejects.toThrow(
      /at most 64 files/,
    )
    expect(api.requests.filter(r => r.method === 'POST')).toEqual([])
  })

  it('accepts sixty-four files', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('stack', { inputs: { files: Array(64).fill(PNG) } })
    expect(Object.keys(parseMultipart(api.calls('POST', '/v1/modules/stack')[0]!))).toEqual(['params', 'files'])
  })

  it('sends a batch through image', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('flipBatch', { image: [PNG, PNG, PNG] })
    expect(api.calls('POST', '/v1/modules/flipBatch')).toHaveLength(1)
  })
})

describe('input files', () => {
  it('fails when a file shrinks while it is sent, without retrying', async () => {
    smallDirectLimit()
    const path = bigFile()
    const api = new FakeApi()
    api.queue('POST', '/v1/uploads', () => {
      writeFileSync(path, BIG.subarray(0, 50))
      return ticket(UPLOAD_A)
    })
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: path }))
    expect(error).toBeInstanceOf(InvalidInputError)
    expect(error.message).toMatch(/got shorter than its 272 bytes/)
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('removes the spooled copy of a stream', async () => {
    const { readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const before = readdirSync(tmpdir()).filter(name => name.startsWith('pixlub-') && !name.startsWith('pixlub-test-'))
    await makeClient(new FakeApi()).tools.run('removeBgApi', { image: Readable.from([PNG]) })
    const after = readdirSync(tmpdir()).filter(name => name.startsWith('pixlub-') && !name.startsWith('pixlub-test-'))
    expect(after).toEqual(before)
  })

  it('refuses a stream of text', async () => {
    const api = new FakeApi()
    await expect(makeClient(api).tools.run('removeBgApi', { image: Readable.from(['text']) })).rejects.toThrow(TypeError)
  })
})

async function capture(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise
  } catch (error) {
    return error as Error & Record<string, unknown>
  }
  throw new Error('expected a rejection')
}
