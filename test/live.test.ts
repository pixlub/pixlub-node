/**
 * Against a real API, only when PIXLUB_BASE_URL is set. Running a tool needs
 * PIXLUB_API_KEY too, and costs credits.
 *
 *   PIXLUB_BASE_URL=https://api.pixlub.com PIXLUB_API_KEY=... npx vitest run test/live.test.ts
 */

import { deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { NotFoundError, Pixlub } from '../src/index.js'

const BASE_URL = process.env.PIXLUB_BASE_URL
const API_KEY = process.env.PIXLUB_API_KEY
const PLACEHOLDER_KEY = 'pix.AbCdEf12.LiveTestOnlyNotARealSecret0123456789'

function client(): Pixlub {
  return new Pixlub({ apiKey: API_KEY || PLACEHOLDER_KEY, baseURL: BASE_URL })
}

/** A valid 1x1 red PNG. */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (data: Buffer): number => {
    let c = 0xffffffff
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (kind: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe.skipIf(!BASE_URL)('live API', () => {
  it('lists the tools', async () => {
    const tools = await client().tools.list()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some(tool => tool.id === 'removeBgApi')).toBe(true)
  })

  it('gives the schema of a known tool', async () => {
    const schema = await client().tools.schema('flip')
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('axis')
  })

  it('answers 404 for the schema of an unknown tool', async () => {
    await expect(client().tools.schema('doesNotExistAnywhere')).rejects.toThrow(NotFoundError)
  })

  it.skipIf(!API_KEY)('runs a local tool on a real image', { timeout: 120_000 }, async () => {
    const result = await client().tools.run('flip', { image: tinyPng(), params: { axis: 'h' } })
    expect(result.contentType).toBe('image/png')
    expect(result.image?.subarray(0, 4).toString('latin1')).toBe('\x89PNG')
    expect(result.creditsBalance).toBeTypeOf('number')
  })
})
