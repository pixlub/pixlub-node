/** The SDK against a real HTTP server on 127.0.0.1, with the fetch of Node.js. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { APIConnectionError, APITimeoutError, Pixlub } from '../src/index.js'
import { clock } from '../src/clock.js'
import { API_KEY, CATALOG, PNG, smallDirectLimit, tempDir } from './helpers.js'

interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: Buffer
}

type Handler = (seen: Seen, res: ServerResponse) => void

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function serve(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', chunk => parts.push(chunk))
    req.on('end', () => {
      const entry = { method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(parts) }
      seen.push(entry)
      handler(entry, res)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, seen }
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Plays the API, the upload server and the result links on one port. */
function fakePixlub(base: () => string): Handler {
  return (seen, res) => {
    if (seen.method === 'GET' && seen.path === '/v1/modules') return json(res, CATALOG)
    if (seen.method === 'POST' && seen.path === '/v1/uploads') {
      return json(res, { upload_id: 'up_1', upload_url: `${base()}/u/up_1`, method: 'PUT' }, 201)
    }
    if (seen.method === 'PUT' && seen.path === '/u/up_1') return json(res, { bytes: seen.body.length })
    if (seen.method === 'POST' && seen.path.startsWith('/v1/modules/')) {
      return json(res, { id: 'run_1', outputs: [{ key: 'out', name: 'image', url: `${base()}/r/out.png` }] })
    }
    if (seen.method === 'GET' && seen.path === '/r/out.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(PNG)
    }
    json(res, { error: 'Unknown route' }, 404)
  }
}

describe('real HTTP', () => {
  it('runs a tool with exact lengths and no chunked encoding', async () => {
    let base = ''
    const server = await serve(fakePixlub(() => base))
    base = server.url
    const client = new Pixlub({ apiKey: API_KEY, baseURL: base })

    const result = await client.tools.run('removeBgApi', { image: PNG, params: { a: 1 } })

    expect(result.image).toEqual(PNG)
    const run = server.seen.find(entry => entry.method === 'POST')!
    expect(run.headers['transfer-encoding']).toBeUndefined()
    expect(Number(run.headers['content-length'])).toBe(run.body.length)
    expect(run.headers['x-api-key']).toBe(API_KEY)
    expect(run.body.toString('latin1')).toContain('{"a":1}')
    const download = server.seen.find(entry => entry.path === '/r/out.png')!
    expect(download.headers['x-api-key']).toBeUndefined()
  })

  it('uploads a large file from disk with its exact length', async () => {
    smallDirectLimit(1000)
    let base = ''
    const server = await serve(fakePixlub(() => base))
    base = server.url
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 5)])
    const path = join(tempDir(), 'big.png')
    writeFileSync(path, big)

    await new Pixlub({ apiKey: API_KEY, baseURL: base }).tools.run('removeBgApi', { image: path })

    const put = server.seen.find(entry => entry.method === 'PUT')!
    expect(put.headers['transfer-encoding']).toBeUndefined()
    expect(put.headers['content-length']).toBe(String(big.length))
    expect(put.headers['content-type']).toBe('image/png')
    expect(put.headers['x-api-key']).toBeUndefined()
    expect(put.body.equals(big)).toBe(true)
  })

  it('does not follow a redirect', async () => {
    const server = await serve((_seen, res) => {
      res.writeHead(302, { location: '/elsewhere' })
      res.end()
    })
    const error = await new Pixlub({ apiKey: API_KEY, baseURL: server.url })
      .tools.list()
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ httpStatus: 302 })
    expect(server.seen.map(entry => entry.path)).toEqual(['/v1/modules'])
  })

  it('stops reading a body larger than allowed', async () => {
    const server = await serve((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = Buffer.alloc(1024 * 1024, 32)
      let sent = 0
      const write = (): void => {
        while (sent < 12 && res.write(chunk)) sent++
        if (sent < 12) res.once('drain', write)
        else res.end()
      }
      write()
    })
    await expect(new Pixlub({ apiKey: API_KEY, baseURL: server.url }).tools.list()).rejects.toThrow(
      /more data than the SDK accepts/,
    )
  })

  it('says a refused connection was never sent, after retrying it', async () => {
    const server = await serve(() => undefined)
    const url = server.url
    await new Promise(resolve => servers.pop()!.close(resolve))
    clock.sleep = async () => undefined
    const error = await new Pixlub({ apiKey: API_KEY, baseURL: url, maxRetries: 1 })
      .tools.run('checker', {})
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(APIConnectionError)
    expect(error).toMatchObject({ requestSent: false })
    expect((error as Error).message).toContain('ECONNREFUSED')
  })

  it('times out a server that does not answer', async () => {
    const server = await serve(() => undefined)
    const error = await new Pixlub({ apiKey: API_KEY, baseURL: server.url, timeout: 100, maxRetries: 0 })
      .tools.list()
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(APITimeoutError)
    expect(error).toMatchObject({ requestSent: true })
  })
})
