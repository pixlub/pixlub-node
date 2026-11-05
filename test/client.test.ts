import { createReadStream, writeFileSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  AbortedError,
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  ConfigurationError,
  FileTooLargeError,
  InsufficientCreditsError,
  InvalidInputError,
  InvalidRequestError,
  NotFoundError,
  PermissionDeniedError,
  Pixlub,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  SourceURL,
  UnexpectedResponseError,
  UnknownToolError,
  VERSION,
} from '../src/index.js'
import { limits } from '../src/core.js'
import {
  API_KEY,
  BASE_URL,
  CATALOG,
  DATA_LINK,
  errorResponse,
  FakeApi,
  fakeTime,
  FILES_HOST,
  IMAGE_LINK,
  IMAGE_PATH,
  imageResponse,
  jsonResponse,
  makeClient,
  networkError,
  parseMultipart,
  parseMultipartAll,
  PNG,
  RUN_ID,
  runResponse,
  tempDir,
} from './helpers.js'

const RUN = '/v1/modules/removeBgApi'

describe('configuration', () => {
  it('reads the key and base URL from the environment', async () => {
    process.env.PIXLUB_API_KEY = API_KEY
    process.env.PIXLUB_BASE_URL = 'https://env.pixlub.test/'
    const api = new FakeApi()
    const client = new Pixlub({ fetch: api.fetch })
    expect(client.baseURL).toBe('https://env.pixlub.test')
    await client.tools.list()
    expect(api.requests[0]!.url.href).toBe('https://env.pixlub.test/v1/modules')
    expect(api.requests[0]!.headers.get('x-api-key')).toBe(API_KEY)
  })

  it('fails before any request without a key', () => {
    expect(() => new Pixlub({ baseURL: BASE_URL })).toThrow(ConfigurationError)
    expect(() => new Pixlub({ apiKey: '  ', baseURL: BASE_URL })).toThrow(/No API key/)
  })

  it('refuses a malformed key without echoing it', () => {
    const error = captureSync(() => new Pixlub({ apiKey: 'sk-not-a-pixlub-key', baseURL: BASE_URL }))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(String(error)).not.toContain('sk-not-a-pixlub-key')
  })

  it('strips whitespace around the key', async () => {
    const api = new FakeApi()
    const client = new Pixlub({ apiKey: `  ${API_KEY}\n`, baseURL: BASE_URL, fetch: api.fetch })
    await client.tools.list()
    expect(api.requests[0]!.headers.get('x-api-key')).toBe(API_KEY)
  })

  it.each([
    ['https://api.pixlub.com', 'https://api.pixlub.com'],
    ['https://api.pixlub.com/', 'https://api.pixlub.com'],
    ['https://example.com/pixlub/', 'https://example.com/pixlub'],
    ['http://localhost:4000', 'http://localhost:4000'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ])('accepts the base URL %s', (given, expected) => {
    expect(new Pixlub({ apiKey: API_KEY, baseURL: given }).baseURL).toBe(expected)
  })

  it.each([
    'http://api.pixlub.com',
    'ftp://api.pixlub.com',
    'https://user:pass@api.pixlub.com',
    'https://api.pixlub.com?x=1',
    'https://api.pixlub.com#frag',
    'not a url',
    'https://api.pixlub.com:99999',
  ])('refuses the base URL %s', given => {
    expect(() => new Pixlub({ apiKey: API_KEY, baseURL: given })).toThrow(ConfigurationError)
  })

  it('uses the public API by default', () => {
    expect(new Pixlub({ apiKey: API_KEY }).baseURL).toBe('https://api.pixlub.com')
  })

  it('never shows the secret', () => {
    const client = makeClient(new FakeApi())
    for (const text of [String(client), inspect(client), inspect(client, { showHidden: true, depth: 5 })]) {
      expect(text).not.toContain('Secret0123456789')
      expect(text).toContain('pix.AbCdEf12.***')
    }
    expect(JSON.stringify(client)).not.toContain('Secret0123456789')
  })

  it('identifies the SDK in the User-Agent', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.list()
    expect(api.requests[0]!.headers.get('user-agent')).toBe(`pixlub-node/${VERSION} (Node ${process.versions.node})`)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number])('refuses the timeout %s', value => {
    expect(() => makeClient(new FakeApi(), { timeout: value })).toThrow(ConfigurationError)
    expect(() => makeClient(new FakeApi(), { jobTimeout: value })).toThrow(ConfigurationError)
  })

  it.each([-1, 6, 1.5])('refuses maxRetries %s', value => {
    expect(() => makeClient(new FakeApi(), { maxRetries: value })).toThrow(ConfigurationError)
  })
})

describe('catalog', () => {
  it('never sends a tool id that is not a plain name', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    for (const id of ['../admin', 'a/b', '', 'x'.repeat(65), 'tool?x=1', 'é']) {
      await expect(client.tools.run(id, { image: PNG })).rejects.toThrow(InvalidInputError)
      await expect(client.tools.schema(id)).rejects.toThrow(InvalidInputError)
    }
    expect(api.requests).toEqual([])
  })

  it('lists every tool, or only the executable ones', async () => {
    const client = makeClient(new FakeApi())
    const tools = await client.tools.list()
    expect(tools.map(tool => tool.id)).toEqual(CATALOG.map(tool => tool.id))
    const runnable = await client.tools.list({ executableOnly: true })
    expect(runnable.map(tool => tool.id)).not.toContain('trimVideo')
    expect(tools[0]!.primaryInput?.id).toBe('image')
    expect(tools[0]!.inputs[0]).toMatchObject({ id: 'image', required: true, maxFiles: 1, perFile: false })
  })

  it('is cached between runs', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    await client.tools.run('removeBgApi', { image: PNG })
    await client.tools.run('removeBgApi', { image: PNG })
    expect(api.calls('GET', '/v1/modules')).toHaveLength(1)
  })

  it('is fetched once for concurrent runs', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    await Promise.all([1, 2, 3].map(() => client.tools.run('removeBgApi', { image: PNG })))
    expect(api.calls('GET', '/v1/modules')).toHaveLength(1)
  })

  it('is fetched again after ten minutes', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    await client.tools.retrieve('removeBgApi')
    fakeTime.now += 601
    await client.tools.retrieve('removeBgApi')
    expect(api.calls('GET', '/v1/modules')).toHaveLength(2)
  })

  it('raises UnknownToolError after one more fetch', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    await expect(client.tools.retrieve('nope')).rejects.toThrow(UnknownToolError)
    expect(api.calls('GET', '/v1/modules')).toHaveLength(2)
  })

  it('finds a tool newer than the cached catalog', async () => {
    const api = new FakeApi()
    const client = makeClient(api)
    await client.tools.list()
    api.queue('GET', '/v1/modules', jsonResponse([...CATALOG, { ...CATALOG[0], id: 'brandNew' }]))
    expect((await client.tools.retrieve('brandNew')).id).toBe('brandNew')
  })

  it('returns the schema as an object', async () => {
    const client = makeClient(new FakeApi())
    expect(await client.tools.schema('removeBgApi')).toMatchObject({ type: 'object' })
  })

  it('refuses a catalog that is not a list', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', jsonResponse({ tools: [] }))
    await expect(makeClient(api).tools.list()).rejects.toThrow(UnexpectedResponseError)
  })

  it('does not read an oversized catalog', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', new Response('[' + ' '.repeat(10 * 1024 * 1024) + ']'))
    await expect(makeClient(api).tools.list()).rejects.toThrow(/more data than the SDK accepts/)
  })
})

describe('run', () => {
  it('sends the key in a header and the image in a multipart body', async () => {
    const api = new FakeApi()
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG, params: { quality: 'high' } })

    expect(result.image).toEqual(PNG)
    const [run] = api.calls('POST', RUN)
    expect(run!.headers.get('x-api-key')).toBe(API_KEY)
    expect(run!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=[0-9a-f]{32}$/)
    expect(run!.headers.get('transfer-encoding')).toBeNull()
    expect(run!.redirect).toBe('manual')
    const fields = parseMultipart(run!)
    expect(Object.keys(fields)).toEqual(['params', 'image'])
    expect(fields.params!.content.toString()).toBe('{"quality":"high"}')
    expect(fields.image).toEqual({ filename: 'image.png', contentType: 'image/png', content: PNG })
  })

  it('keeps the file name of a path', async () => {
    const api = new FakeApi()
    const path = join(tempDir(), 'my "photo".png')
    writeFileSync(path, PNG)
    await makeClient(api).tools.run('removeBgApi', { image: path })
    const fields = parseMultipart(api.calls('POST', RUN)[0]!)
    expect(fields.image!.filename).toBe('my _photo_.png')
    expect(fields.image!.content).toEqual(PNG)
  })

  it('reads a file: URL, a Blob, a File and streams', async () => {
    const folder = tempDir()
    const path = join(folder, 'in.png')
    writeFileSync(path, PNG)
    const sources = [
      new URL(`file://${path}`),
      new Blob([PNG]),
      new File([PNG], 'named.png', { type: 'image/png' }),
      createReadStream(path),
      Readable.from([PNG.subarray(0, 10), PNG.subarray(10)]),
      Readable.toWeb(Readable.from([PNG])),
      (async function* () {
        yield PNG
      })(),
    ]
    for (const source of sources) {
      const api = new FakeApi()
      await makeClient(api).tools.run('removeBgApi', { image: source as never })
      const fields = parseMultipart(api.calls('POST', RUN)[0]!)
      expect(fields.image!.content).toEqual(PNG)
      expect(fields.image!.contentType).toBe('image/png')
    }
  })

  it('names a File and a file stream after them', async () => {
    const folder = tempDir()
    const path = join(folder, 'stream.png')
    writeFileSync(path, PNG)
    for (const [source, name] of [
      [new File([PNG], 'named.png'), 'named.png'],
      [createReadStream(path), 'stream.png'],
    ] as const) {
      const api = new FakeApi()
      await makeClient(api).tools.run('removeBgApi', { image: source })
      expect(parseMultipart(api.calls('POST', RUN)[0]!).image!.filename).toBe(name)
    }
  })

  it('sends several named inputs', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('mask', { inputs: { image: PNG, mask: PNG } })
    expect(Object.keys(parseMultipart(api.calls('POST', '/v1/modules/mask')[0]!))).toEqual(['params', 'image', 'mask'])
  })

  it('still sends multipart for a tool without inputs', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('checker', { params: { size: 8 } })
    const fields = parseMultipart(api.calls('POST', '/v1/modules/checker')[0]!)
    expect(Object.keys(fields)).toEqual(['params'])
  })

  it('sends a list of files for an input that takes several', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('collage', { inputs: { background: PNG, tiles: [PNG, PNG, PNG] } })
    const names = parseMultipartAll(api.calls('POST', '/v1/modules/collage')[0]!).map(([name]) => name)
    expect(names).toEqual(['params', 'background', 'tiles', 'tiles', 'tiles'])
  })

  it.each([
    ['mask', { image: PNG }, /takes several images/],
    ['mask', { inputs: { image: PNG } }, /missing required input\(s\): mask/],
    ['removeBgApi', { inputs: { image: PNG, other: PNG } }, /no input named 'other'/],
    ['removeBgApi', { inputs: {} }, /non-empty object/],
    ['removeBgApi', {}, /needs a file for: image/],
    ['removeBgApi', { image: PNG, inputs: { image: PNG } }, /either image or inputs/],
    ['checker', { image: PNG }, /takes no image/],
    ['trimVideo', {}, /cannot be run through the API/],
    ['removeBgApi', { image: [PNG, PNG] }, /takes one file, not a list/],
    ['removeBgApi', { image: [] }, /empty list/],
    ['collage', { inputs: { background: PNG, tiles: [PNG, PNG, PNG, PNG, PNG] } }, /at most 4 files/],
    ['removeBgApi', { image: Buffer.alloc(0) }, /is empty/],
    ['removeBgApi', { image: '/nonexistent/photo.png' }, /No such file or directory/],
    ['removeBgApi', { image: '/' }, /not a regular file/],
    ['removeBgApi', { image: new URL('https://example.com/a.png') }, /SourceURL/],
    ['removeBgApi', { image: PNG, params: { bad: Number.NaN } }, /only JSON values/],
    ['removeBgApi', { image: PNG, params: { when: new Date() } }, /only JSON values/],
    ['removeBgApi', { image: PNG, params: { big: 10n } }, /only JSON values/],
    ['removeBgApi', { image: PNG, params: [1, 2] }, /params must be an object/],
  ] as const)('refuses %s case %# before sending', async (tool, options, message) => {
    const api = new FakeApi()
    await expect(makeClient(api).tools.run(tool, options as never)).rejects.toThrow(message)
    expect(api.requests.filter(request => request.method !== 'GET')).toEqual([])
  })

  it('refuses a circular params object', async () => {
    const params: Record<string, unknown> = {}
    params.self = params
    await expect(makeClient(new FakeApi()).tools.run('removeBgApi', { image: PNG, params })).rejects.toThrow(
      /circular/,
    )
  })

  it('refuses unsupported image types with a TypeError', async () => {
    const api = new FakeApi()
    await expect(makeClient(api).tools.run('removeBgApi', { image: 42 as never })).rejects.toThrow(TypeError)
    await expect(makeClient(api).tools.run('removeBgApi', { image: { a: 1 } as never })).rejects.toThrow(TypeError)
  })

  it('refuses a file larger than maxInputBytes before sending', async () => {
    const api = new FakeApi()
    const client = makeClient(api, { maxInputBytes: 10 })
    await expect(client.tools.run('removeBgApi', { image: PNG })).rejects.toThrow(/72 bytes; the limit is 10 bytes/)
    await expect(client.tools.run('removeBgApi', { image: Readable.from([PNG]) })).rejects.toThrow(/limit is 10/)
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('reads message and credits of the result', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse(undefined, { message: 'Low contrast.' }))
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result).toMatchObject({
      id: RUN_ID,
      module: 'removeBgApi',
      cost: 10,
      creditsBalance: 41,
      message: 'Low contrast.',
      expiresAt: '2026-10-13T10:00:00Z',
      contentType: 'image/png',
      extension: '.png',
    })
    expect(result.output('out')?.bytes).toBe(PNG.length)
  })

  it('refuses a run answer without outputs and says it was charged', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse([]))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(UnexpectedResponseError)
    expect(error.message).toContain(`Run ${RUN_ID} succeeded and was charged`)
  })

  it('says an unreadable run answer was charged', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, new Response('not json', { status: 200 }))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(UnexpectedResponseError)
    expect(error.message).toContain('The run succeeded and was charged')
  })

  it('downloads outputs without the key', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    const [download] = api.calls('GET', IMAGE_PATH)
    expect(download!.url.host).toBe(FILES_HOST)
    expect(download!.headers.get('x-api-key')).toBeNull()
    expect(download!.redirect).toBe('manual')
  })

  it('parses the data output', async () => {
    const api = new FakeApi()
    api.queue(
      'POST',
      RUN,
      runResponse([
        { key: 'out', name: 'image', url: IMAGE_LINK, content_type: 'image/png' },
        { key: 'faces', name: 'data', url: DATA_LINK, content_type: 'application/json' },
      ]),
    )
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.data).toEqual({ faces: [] })
    expect(result.output('faces')?.json()).toEqual({ faces: [] })
    expect(result.output('data')?.key).toBe('faces')
    expect(result.image).toEqual(PNG)
  })

  it('has no image when the tool only returns data', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse([{ key: 'faces', name: 'data', url: DATA_LINK, content_type: 'application/json' }]))
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.image).toBeUndefined()
    expect(result.file).toBeUndefined()
    expect(result.extension).toBe('.json')
    await expect(result.save(join(tempDir(), 'x'))).rejects.toThrow(/only data/)
  })

  it('resolves relative links against the base URL', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse([{ name: 'image', url: `/r/${RUN_ID}_result.png?sig=x` }]))
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    const [download] = api.calls('GET', `/r/${RUN_ID}_result.png`)
    expect(download!.url.host).toBe('api.pixlub.test')
    expect(download!.headers.get('x-api-key')).toBeNull()
  })

  it.each([
    'http://files.pixlub.com/r/x.png',
    'https://user:pw@files.pixlub.com/r/x.png',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '',
  ])('never downloads the unsafe link %s', async url => {
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse([{ name: 'image', url }]))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(UnexpectedResponseError)
    expect(api.requests.map(request => request.url.host)).not.toContain('files.pixlub.com')
  })

  it('reports an expired link as a permission error', async () => {
    const api = new FakeApi()
    api.queue('GET', IMAGE_PATH, errorResponse(403, 'link_expired'))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(PermissionDeniedError)
    expect(error.message).toContain('succeeded and was charged')
  })

  it('retries a failed download without running again', async () => {
    const api = new FakeApi()
    api.queue('GET', IMAGE_PATH, errorResponse(503, 'busy'), networkError('ECONNRESET'))
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.image).toEqual(PNG)
    expect(api.calls('GET', IMAGE_PATH)).toHaveLength(3)
    expect(api.calls('POST', RUN)).toHaveLength(1)
  })

  it('does not keep an oversized output', async () => {
    limits.maxOutputBytes = 10
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse([{ name: 'image', url: IMAGE_LINK }]))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(
      /larger than 10 bytes and was not read/,
    )
  })

  it('does not download an output announced too large', async () => {
    limits.maxOutputBytes = 10
    const api = new FakeApi()
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(/get it from its link/)
    expect(api.calls('GET', IMAGE_PATH)).toEqual([])
  })

  it('does not download outputs too large together', async () => {
    limits.maxRunOutputBytes = 100
    const api = new FakeApi()
    const output = { name: 'image', url: IMAGE_LINK, bytes: 60 }
    api.queue('POST', RUN, runResponse([output, output]))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(/larger than the SDK/)
    expect(api.calls('GET', IMAGE_PATH)).toEqual([])
  })

  it('keeps the contract limits on outputs', () => {
    expect(limits.maxOutputBytes).toBe(1024 ** 3)
    expect(limits.maxRunOutputBytes).toBe(4 * 1024 ** 3)
  })

  it('downloads many outputs four at a time, in order', async () => {
    const api = new FakeApi()
    let running = 0
    let peak = 0
    const outputs = Array.from({ length: 10 }, (_, i) => ({
      key: `out#${i}`,
      name: 'image',
      url: `https://${FILES_HOST}/r/${i}_result.png`,
    }))
    api.queue('POST', RUN, runResponse(outputs))
    for (let i = 0; i < 10; i++) {
      api.queue('GET', `/r/${i}_result.png`, async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise(resolve => setTimeout(resolve, 5))
        running--
        return imageResponse(Buffer.from([i]))
      })
    }
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.outputs.map(output => output.content[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.output('out#3')?.content).toEqual(Buffer.from([3]))
    expect(peak).toBe(4)
  })

  it('ignores parameters of the output content type', async () => {
    const api = new FakeApi()
    api.queue('GET', IMAGE_PATH, imageResponse(PNG, { 'content-type': 'Image/PNG; charset=binary' }))
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.contentType).toBe('image/png')
  })

  it('keeps output names and keys to safe forms', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, runResponse([{ key: '../../x', name: 'Image\n', url: IMAGE_LINK }]))
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.outputs[0]).toMatchObject({ key: '', name: 'file' })
    expect(result.file?.content).toEqual(PNG)
  })

  it('never dumps the content when inspected', async () => {
    const result = await makeClient(new FakeApi()).tools.run('removeBgApi', { image: PNG })
    expect(inspect(result.outputs[0])).toContain('<72 bytes>')
  })
})

describe('save', () => {
  it('writes the file and refuses to overwrite by default', async () => {
    const result = await makeClient(new FakeApi()).tools.run('removeBgApi', { image: PNG })
    const path = join(tempDir(), `out${result.extension}`)
    expect(await result.save(path)).toBe(path)
    expect(await readFile(path)).toEqual(PNG)
    await expect(result.save(path)).rejects.toMatchObject({ code: 'EEXIST' })
    await writeFile(path, 'old')
    await result.save(path, { overwrite: true })
    expect(await readFile(path)).toEqual(PNG)
  })

  it('never writes through a symbolic link', async () => {
    const result = await makeClient(new FakeApi()).tools.run('removeBgApi', { image: PNG })
    const folder = tempDir()
    await writeFile(join(folder, 'target'), 'keep')
    await symlink(join(folder, 'target'), join(folder, 'link'))
    await expect(result.save(join(folder, 'link'))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(result.save(join(folder, 'link'), { overwrite: true })).rejects.toThrow(/symbolic link/)
    expect(await readFile(join(folder, 'target'), 'utf8')).toBe('keep')
  })
})

describe('errors', () => {
  it.each([
    [400, InvalidRequestError],
    [401, AuthenticationError],
    [402, InsufficientCreditsError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [413, FileTooLargeError],
    [422, InvalidRequestError],
    [429, RateLimitError],
    [500, ServerError],
    [502, ServerError],
    [503, ServiceUnavailableError],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const api = new FakeApi()
    api.queue('POST', RUN, errorResponse(status, 'some_code'))
    const error = await capture(makeClient(api, { maxRetries: 0 }).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(kind)
    expect(error).toBeInstanceOf(APIError)
    expect(error).toMatchObject({ httpStatus: status, code: 'some_code', name: kind.name })
    expect(error.message).toBe(`Failure some_code (HTTP ${status}, code=some_code)`)
  })

  it('exposes the required credits', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, errorResponse(402, 'insufficient_credits', { required: 25 }))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toMatchObject({ requiredCredits: 25 })
  })

  it('exposes the details of invalid params', async () => {
    const api = new FakeApi()
    const details = [{ path: '/width', message: 'must be <= 4096' }]
    api.queue('POST', RUN, jsonResponse({ error: 'Invalid params', code: 'invalid_params', details }, 422))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect(error).toMatchObject({ details, body: { code: 'invalid_params' } })
  })

  it('reads every limit field', async () => {
    const api = new FakeApi()
    api.queue(
      'POST',
      RUN,
      jsonResponse(
        { message: 'Too big', code: 'image_too_large', max_bytes: 100, max_pixels: 4e7, limit: 3, reset_at: '2026-11-01T00:00:00Z' },
        413,
      ),
    )
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toMatchObject({ maxBytes: 100, maxPixels: 4e7, limit: 3, resetAt: '2026-11-01T00:00:00Z' })
  })

  it('never contains the key, nor control characters', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, jsonResponse({ error: `bad key ${API_KEY}\r\nFAKE LOG LINE` }, 400))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error.message).not.toContain('Secret0123456789')
    expect(error.message).toContain('pix.AbCdEf12.***')
    expect(error.message).not.toMatch(/[\r\n]/)
  })

  it('never follows a redirect', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }))
    const error = await capture(makeClient(api).tools.list())
    expect(error).toBeInstanceOf(APIError)
    expect(error).toMatchObject({ httpStatus: 302 })
    expect(api.requests).toHaveLength(1)
  })
})

describe('retries', () => {
  it('retries a GET on 503', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', errorResponse(503, 'busy'), errorResponse(502, 'bad_gateway'))
    expect(await makeClient(api).tools.list()).toHaveLength(CATALOG.length)
    expect(api.calls('GET', '/v1/modules')).toHaveLength(3)
    expect(fakeTime.waits).toHaveLength(2)
  })

  it('does not retry a POST after a server error', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, errorResponse(500, 'boom'))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(ServerError)
    expect(api.calls('POST', RUN)).toHaveLength(1)
  })

  it('retries a POST on 429 and waits as asked', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '7' }))
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(api.calls('POST', RUN)).toHaveLength(2)
    expect(fakeTime.waits).toEqual([7])
    const [first, second] = api.calls('POST', RUN)
    expect(parseMultipart(first!).image!.content).toEqual(parseMultipart(second!).image!.content)
  })

  it('caps Retry-After', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, jsonResponse({ error: 'slow' }, 429, { 'retry-after': '3600' }))
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(fakeTime.waits).toEqual([60])
  })

  it('reads retry_after from the body without a header', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, jsonResponse({ error: 'slow', retry_after: 4 }, 429))
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(fakeTime.waits).toEqual([4])
  })

  it('retries a POST when the connection was refused', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, networkError('ECONNREFUSED', 'connect'))
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(api.calls('POST', RUN)).toHaveLength(2)
  })

  it.each(['ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'retries a POST that never left (%s)',
    async code => {
      const api = new FakeApi()
      api.queue('POST', RUN, networkError(code))
      await makeClient(api).tools.run('removeBgApi', { image: PNG })
      expect(api.calls('POST', RUN)).toHaveLength(2)
    },
  )

  it('does not retry a POST that timed out after being sent', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, networkError('UND_ERR_HEADERS_TIMEOUT'))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(APITimeoutError)
    expect(error).toMatchObject({ requestSent: true })
    expect(error.message).toContain('check your credit balance')
    expect(api.calls('POST', RUN)).toHaveLength(1)
  })

  it('does not retry a POST whose connection broke', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, networkError('ECONNRESET'))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(APIConnectionError)
    expect(error).not.toBeInstanceOf(APITimeoutError)
    expect(api.calls('POST', RUN)).toHaveLength(1)
  })

  it('retries a GET that timed out', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', networkError('UND_ERR_BODY_TIMEOUT'))
    await makeClient(api).tools.list()
    expect(api.calls('GET', '/v1/modules')).toHaveLength(2)
  })

  it('reports a request that was never sent after the retries', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', ...[1, 2, 3].map(() => networkError('ECONNREFUSED', 'connect')))
    const error = await capture(makeClient(api).tools.list())
    expect(error).toBeInstanceOf(APIConnectionError)
    expect(error).toMatchObject({ requestSent: false })
    expect(error.message).not.toContain('credit balance')
    expect(api.requests).toHaveLength(3)
  })

  it('does not retry when maxRetries is 0', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', errorResponse(503, 'busy'))
    await expect(makeClient(api, { maxRetries: 0 }).tools.list()).rejects.toThrow(ServiceUnavailableError)
    expect(api.requests).toHaveLength(1)
  })

  it('surfaces a bug in a custom fetch instead of retrying it', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', new RangeError('bug in a custom fetch'))
    await expect(makeClient(api).tools.list()).rejects.toThrow(RangeError)
    expect(api.requests).toHaveLength(1)
  })
})

describe('timeouts and cancellation', () => {
  function hangingFetch(calls: RequestInit[]) {
    return (_url: string, init: RequestInit): Promise<Response> => {
      calls.push(init)
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }
  }

  it('aborts a request that gets no answer within the timeout', async () => {
    const calls: RequestInit[] = []
    const client = new Pixlub({ apiKey: API_KEY, baseURL: BASE_URL, fetch: hangingFetch(calls), timeout: 30, maxRetries: 1 })
    const error = await capture(client.tools.list())
    expect(error).toBeInstanceOf(APITimeoutError)
    expect(calls).toHaveLength(2)
  })

  it('keeps reading a body that keeps coming', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', () => {
      const text = JSON.stringify(CATALOG)
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 15))
          if (sent >= text.length) return controller.close()
          controller.enqueue(Buffer.from(text.slice(sent, sent + 400)))
          sent += 400
        },
      })
      return new Response(body, { status: 200 })
    })
    const tools = await makeClient(api, { timeout: 60 }).tools.list()
    expect(tools).toHaveLength(CATALOG.length)
  })

  it('rejects with AbortedError when the signal aborts', async () => {
    const calls: RequestInit[] = []
    const client = new Pixlub({ apiKey: API_KEY, baseURL: BASE_URL, fetch: hangingFetch(calls) })
    const controller = new AbortController()
    const pending = capture(client.tools.list({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error('user stop'))
    const error = await pending
    expect(error).toBeInstanceOf(AbortedError)
    expect((error.cause as Error).message).toBe('user stop')
    expect(calls).toHaveLength(1)
  })

  it('sends nothing with a signal already aborted', async () => {
    const api = new FakeApi()
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG, signal: AbortSignal.abort() }))
    expect(error).toBeInstanceOf(AbortedError)
    expect(api.requests).toEqual([])
  })

  it('stops waiting between retries when aborted', async () => {
    const api = new FakeApi()
    const controller = new AbortController()
    api.queue('GET', '/v1/modules', () => {
      controller.abort()
      return errorResponse(503, 'busy')
    })
    const error = await capture(makeClient(api).tools.list({ signal: controller.signal }))
    expect(error).toBeInstanceOf(AbortedError)
    expect(api.requests).toHaveLength(1)
  })

  it('passes a per-call timeout', async () => {
    const calls: RequestInit[] = []
    const client = new Pixlub({ apiKey: API_KEY, baseURL: BASE_URL, fetch: hangingFetch(calls), maxRetries: 0 })
    const started = performance.now()
    await expect(client.tools.list({ timeout: 25 })).rejects.toThrow(APITimeoutError)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('source URLs', () => {
  it('sends a SourceURL as a field', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('removeBgApi', { image: new SourceURL('https://example.com/a.jpg') })
    const fields = parseMultipart(api.calls('POST', RUN)[0]!)
    expect(Object.keys(fields)).toEqual(['params', 'source_url'])
    expect(fields.source_url!.content.toString()).toBe('https://example.com/a.jpg')
  })

  it('keeps the other inputs with a SourceURL', async () => {
    const api = new FakeApi()
    await makeClient(api).tools.run('mask', { inputs: { image: new SourceURL('https://example.com/a.jpg'), mask: PNG } })
    const fields = parseMultipart(api.calls('POST', '/v1/modules/mask')[0]!)
    expect(Object.keys(fields)).toEqual(['params', 'source_url', 'mask'])
  })

  it.each([
    [{ inputs: { image: PNG, mask: new SourceURL('https://example.com/m.png') } }, /can only fill 'image'/],
    [{ inputs: { image: [new SourceURL('https://example.com/a.png')], mask: PNG } }, undefined],
  ])('places a SourceURL only in the main input', async (options, message) => {
    const api = new FakeApi()
    const run = makeClient(api).tools.run('mask', options as never)
    if (message) await expect(run).rejects.toThrow(message)
    else await expect(run).resolves.toBeDefined()
  })

  it('treats a plain string as a path, never as a URL', async () => {
    const api = new FakeApi()
    await expect(makeClient(api).tools.run('removeBgApi', { image: 'https://example.com/a.jpg' })).rejects.toThrow(
      /Cannot read https:\/\/example.com\/a.jpg/,
    )
    expect(api.requests.filter(request => request.url.host === 'example.com')).toEqual([])
  })
})

describe('JSON of the API', () => {
  it('serialises nothing but a masked key', () => {
    const client = makeClient(new FakeApi())
    expect(Object.keys(client)).toEqual(['tools', 'baseURL'])
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

function captureSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected an exception')
}

describe('shared catalog fetch', () => {
  it('lets one caller abort without failing the others', async () => {
    let release: (() => void) | undefined
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', () => new Promise<Response>(resolve => (release = () => resolve(jsonResponse(CATALOG)))))
    const client = makeClient(api)
    const controller = new AbortController()
    const first = client.tools.list({ signal: controller.signal }).catch((error: unknown) => error)
    const second = client.tools.list()
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    expect(await first).toBeInstanceOf(AbortedError)
    release!()
    expect(await second).toHaveLength(CATALOG.length)
    expect(api.calls('GET', '/v1/modules')).toHaveLength(1)
  })

  it('checks the options of every method', async () => {
    const client = makeClient(new FakeApi())
    await expect(client.tools.list({ timeout: -5 })).rejects.toThrow(ConfigurationError)
    await expect(client.tools.schema('flip', { timeout: 0 })).rejects.toThrow(ConfigurationError)
    await expect(client.tools.retrieve('flip', { signal: 'stop' as never })).rejects.toThrow(ConfigurationError)
    await expect(client.tools.run('removeBgApi', { image: PNG, timeout: Number.NaN })).rejects.toThrow(
      ConfigurationError,
    )
  })

  it('drops catalog inputs whose id is not a plain name', async () => {
    const api = new FakeApi()
    api.queue(
      'GET',
      '/v1/modules',
      jsonResponse([{ ...CATALOG[0], inputs: [{ id: 'image"\r\nX-Evil: 1', required: true }, { id: 'image', required: true }] }]),
    )
    const [tool] = await makeClient(api).tools.list()
    expect(tool!.inputs.map(input => input.id)).toEqual(['image'])
  })
})
