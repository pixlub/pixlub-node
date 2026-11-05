import { describe, expect, it } from 'vitest'

import { SourceURL, Tool } from '../src/index.js'
import { resolveLink } from '../src/config.js'
import {
  encodeParams,
  errorFromResponse,
  parseTimestamp,
  planRun,
  planTransport,
  receiptFromResponse,
  toolFromPayload,
} from '../src/core.js'
import { extensionFor, MultipartBody, prepareFile, sniffContentType } from '../src/files.js'
import { retryHint, type RawResponse } from '../src/http.js'
import {
  backoffSeconds,
  failureFor,
  parseRetryAfter,
  statusIsRetryable,
  uploadIncompletePause,
} from '../src/retry.js'
import { API_KEY, BASE_URL, CATALOG, IMAGE_LINK, PNG } from './helpers.js'

function raw(status: number, body: unknown = {}, headers: Record<string, string> = {}): RawResponse {
  const data = typeof body === 'string' ? body : JSON.stringify(body)
  return { status, headers: new Headers(headers), body: Buffer.from(data), tooLarge: false }
}

async function collect(chunks: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}

describe('files', () => {
  it('recognises common formats', () => {
    const cases: [string, number[] | string][] = [
      ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
      ['image/gif', 'GIF89a'],
      ['image/webp', 'RIFF\0\0\0\0WEBPVP8 '],
      ['image/bmp', 'BM'],
      ['image/tiff', [0x49, 0x49, 0x2a, 0x00]],
      ['image/tiff', [0x4d, 0x4d, 0x00, 0x2a]],
      ['image/avif', '\0\0\0\x1cftypavif'],
    ]
    for (const [type, head] of cases) {
      expect(sniffContentType(Buffer.from(typeof head === 'string' ? Buffer.from(head, 'latin1') : head))).toBe(type)
    }
    expect(sniffContentType(Buffer.from('hello'))).toBeUndefined()
  })

  it('names bytes after their type, and sends unknown content as octet-stream', async () => {
    expect((await prepareFile(PNG, 'image', 1e6)).filename).toBe('image.png')
    const unknown = await prepareFile(Buffer.from('plain text'), 'doc', 1e6)
    expect(unknown).toMatchObject({ filename: 'doc.img', contentType: 'application/octet-stream' })
    const typed = await prepareFile(new Blob(['x'], { type: 'application/pdf' }), 'doc', 1e6)
    expect(typed).toMatchObject({ filename: 'doc.pdf', contentType: 'application/pdf' })
  })

  it('cleans the name of a File', async () => {
    const file = await prepareFile(new File([PNG], '../../evil\r\n"x".png'), 'image', 1e6)
    expect(file.filename).toBe('evil___x_.png')
  })

  it('sends a multipart body of exactly its length', async () => {
    const file = await prepareFile(PNG, 'image', 1e6)
    const body = new MultipartBody([['params', '{}']], [file])
    const bytes = await collect(body.chunks())
    expect(bytes.length).toBe(body.length)
    expect(bytes.toString('latin1')).toContain('Content-Disposition: form-data; name="image"; filename="image.png"')
  })

  it('accepts only public https source URLs', () => {
    for (const url of [
      'http://example.com/a.png',
      'https://example.com:8443/a.png',
      'https://user:pw@example.com/a.png',
      'https://@example.com/a.png',
      'https://example.com/a b.png',
      'https://example.com/\na',
      `https://example.com/${'a'.repeat(2048)}`,
      'file:///etc/passwd',
      '',
    ]) {
      expect(() => new SourceURL(url), url).toThrow()
    }
    expect(new SourceURL(' https://example.com:443/a.png?x=1 ').url).toBe('https://example.com:443/a.png?x=1')
    expect(String(new SourceURL('https://example.com/a.png'))).toBe('https://example.com/a.png')
  })

  it('gives a generic extension to unknown types', () => {
    expect(extensionFor('image/x-unknown')).toBe('.img')
    expect(extensionFor('image/jpeg')).toBe('.jpg')
  })
})

describe('retry policy', () => {
  it('retries statuses by method', () => {
    expect(statusIsRetryable('GET', 503)).toBe(true)
    expect(statusIsRetryable('GET', 507)).toBe(false)
    expect(statusIsRetryable('PUT', 507)).toBe(true)
    expect(statusIsRetryable('POST', 503)).toBe(false)
    expect(statusIsRetryable('POST', 429)).toBe(true)
    expect(statusIsRetryable('GET', 404)).toBe(false)
  })

  it('retries a failure that was never sent, and any failure of GET and PUT', () => {
    expect(failureFor('x', 'POST', { sent: false, timedOut: false }).retryable).toBe(true)
    expect(failureFor('x', 'POST', { sent: true, timedOut: true }).retryable).toBe(false)
    expect(failureFor('x', 'GET', { sent: true, timedOut: true }).retryable).toBe(true)
    expect(failureFor('x', 'PUT', { sent: true, timedOut: false }).retryable).toBe(true)
  })

  it('grows pauses and caps them', () => {
    expect([0, 1, 2, 3, 4, 5].map(attempt => uploadIncompletePause(attempt))).toEqual([1, 2, 4, 8, 8, 8])
    expect(uploadIncompletePause(0, 30)).toBe(30)
    for (let attempt = 0; attempt < 8; attempt++) {
      const ceiling = Math.min(8, 0.5 * 2 ** attempt)
      const delay = backoffSeconds(attempt)
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2)
      expect(delay).toBeLessThanOrEqual(ceiling)
    }
    expect(backoffSeconds(0, 600)).toBe(60)
    expect(backoffSeconds(3, 0)).toBe(0)
  })

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('12')).toBe(12)
    expect(parseRetryAfter(' 3 ')).toBe(3)
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter('-5')).toBeUndefined()
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(0)
    const future = new Date(Date.now() + 30_000).toUTCString()
    expect(parseRetryAfter(future)).toBeGreaterThan(25)
  })

  it('reads the hint from the header, then from the body', () => {
    expect(retryHint(raw(429, { retry_after: 9 }, { 'retry-after': '3' }))).toBe(3)
    expect(retryHint(raw(429, { retry_after: 9 }))).toBe(9)
    expect(retryHint(raw(429, { retry_after: -1 }))).toBeUndefined()
    expect(retryHint(raw(429, 'not json'))).toBeUndefined()
  })
})

describe('catalog parsing', () => {
  it('rejects an entry without an id', () => {
    expect(() => toolFromPayload({ name: 'x' })).toThrow(/without an id/)
    expect(() => toolFromPayload('x')).toThrow(/without an id/)
  })

  it('tolerates missing optional fields', () => {
    const tool = toolFromPayload({ id: 'bare' })
    expect(tool).toMatchObject({ id: 'bare', name: 'bare', executable: false, handler: 'none', inputs: [], outputs: [] })
    expect(tool.primaryInput).toBeUndefined()
    const typed = toolFromPayload({ id: 't', inputs: [{ id: 'a' }, { label: 'no id' }, 'junk'] })
    expect(typed.inputs).toEqual([
      { id: 'a', label: '', required: false, type: 'image', description: '', multiple: false, perFile: false, maxFiles: undefined, accept: [] },
    ])
  })

  it('reads input and output details', () => {
    const tool = toolFromPayload(CATALOG[4])
    expect(tool.inputs[1]).toMatchObject({ id: 'tiles', multiple: true, maxFiles: 4 })
    expect(tool.outputs[0]).toEqual({
      key: 'out',
      label: 'Image',
      description: 'The produced image.',
      kind: 'image',
      multiple: false,
      contentTypes: ['image/png'],
    })
    expect(Object.isFrozen(tool)).toBe(true)
    expect(Object.isFrozen(tool.inputs[0])).toBe(true)
  })

  it('picks the first required input as the main one', () => {
    const tool = new Tool({
      ...toolFromPayload(CATALOG[0]),
      inputs: [
        { ...toolFromPayload(CATALOG[0]).inputs[0]!, id: 'optional', required: false },
        { ...toolFromPayload(CATALOG[0]).inputs[0]!, id: 'main', required: true },
      ],
      outputs: [],
    })
    expect(tool.primaryInput?.id).toBe('main')
  })
})

describe('params', () => {
  it('are compact and strict', () => {
    expect(encodeParams(undefined)).toBe('{}')
    expect(encodeParams({ a: 1, b: [true, null, 'x'], c: { d: 2.5 } })).toBe('{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}')
    for (const bad of [{ a: Number.POSITIVE_INFINITY }, { a: undefined }, { a: () => 1 }, { a: new Map() }, { a: Symbol('x') }]) {
      expect(() => encodeParams(bad)).toThrow(/only JSON values/)
    }
    expect(() => encodeParams('x')).toThrow(/must be an object/)
  })
})

describe('transport plan', () => {
  it('chooses direct or upload', async () => {
    const tool = toolFromPayload(CATALOG[1])
    const plan = planRun('mask', tool, { inputs: { image: PNG, mask: PNG } })
    const files = [await prepareFile(PNG, 'image', 1e6), await prepareFile(PNG, 'mask', 1e6)]
    expect(planTransport(plan, files).upload).toBeUndefined()
    const forced = planTransport(plan, files, { forceUpload: true })
    expect(forced.upload?.formName).toBe('image')
    expect(forced.direct.map(file => file.formName)).toEqual(['mask'])
    expect(() => planTransport(plan, files, { forceUpload: true, directLimit: 10 })).toThrow(/other inputs total 72/)
  })
})

describe('answers', () => {
  it('parses timestamps in any RFC 3339 form', () => {
    const at = Date.parse('2026-10-13T10:00:00Z') / 1000
    expect(parseTimestamp('2026-10-13T10:00:00Z')).toBe(at)
    expect(parseTimestamp('2026-10-13T10:00:00.123456789Z')).toBeCloseTo(at + 0.123, 3)
    expect(parseTimestamp('2026-10-13T12:00:00+02:00')).toBe(at)
    expect(parseTimestamp('2026-10-13T10:00:00')).toBe(at)
    expect(parseTimestamp('2026-10-13t10:00:00z')).toBe(at)
    expect(parseTimestamp('yesterday')).toBeUndefined()
    expect(parseTimestamp(42)).toBeUndefined()
  })

  it('reads a full batch of 256 outputs, and refuses more', () => {
    const outputs = Array.from({ length: 256 }, (_, i) => ({ key: `out#${i}`, name: 'image', url: IMAGE_LINK }))
    expect(receiptFromResponse(raw(200, { outputs }), API_KEY, BASE_URL).outputs).toHaveLength(256)
    expect(() => receiptFromResponse(raw(200, { outputs: [...outputs, outputs[0]] }), API_KEY, BASE_URL)).toThrow(
      /at most 256/,
    )
  })

  it('exposes error details and redacts the key', () => {
    const error = errorFromResponse(
      raw(429, { message: `slow ${API_KEY}`, code: 'rate_limited', retry_after: 12, reset_at: 'x'.repeat(100) }),
      API_KEY,
    )
    expect(error).toMatchObject({ httpStatus: 429, code: 'rate_limited', retryAfter: 12 })
    expect(error.resetAt).toHaveLength(64)
    expect(error.message).toBe('slow pix.AbCdEf12.*** (HTTP 429, code=rate_limited)')
    expect(errorFromResponse(raw(500, 'oops'), API_KEY).message).toBe(
      'The Pixlub API returned HTTP 500. (HTTP 500)',
    )
  })

  it('checks links', () => {
    expect(resolveLink('/r/x.png', BASE_URL)).toBe('https://api.pixlub.test/r/x.png')
    expect(resolveLink('http://localhost:4000/r', 'http://localhost:4000')).toBe('http://localhost:4000/r')
    expect(() => resolveLink('http://evil.test/r', BASE_URL)).toThrow(/plain http/)
    expect(() => resolveLink('//user:pw@evil.test/r', BASE_URL)).toThrow(/credentials/)
    expect(() => resolveLink('data:text/plain,hi', BASE_URL)).toThrow(/not an http/)
  })
})
