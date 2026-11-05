# pixlub

Official Node.js SDK for the [Pixlub](https://pixlub.com) API. Node.js 22+,
ES modules and CommonJS, TypeScript types included, no dependencies.

Documentation: [getting started with the API](https://pixlub.com/en/docs/api/getting-started)
and [every module, its inputs and settings](https://pixlub.com/en/docs/modules).

## Install

```bash
npm install pixlub
```

## Quick start

1. Create an API key in your Pixlub dashboard. API keys need a paid plan.
2. Put it in an environment variable, never in your source code:

   ```bash
   export PIXLUB_API_KEY="pix.xxxxxxxx.xxxxxxxx..."
   ```

3. Run a tool:

   ```ts
   import { Pixlub } from 'pixlub'

   const client = new Pixlub()
   const result = await client.tools.run('removeBgApi', { image: 'photo.jpg' })
   await result.save(`photo-nobg${result.extension}`)
   ```

   With CommonJS: `const { Pixlub } = require('pixlub')`.

`result.extension` matches the produced file: `.webp` for `removeBgApi`, `.png`
for most tools. `save()` refuses to replace an existing file unless
`{ overwrite: true }`, writes it readable by its owner only, and never writes
through a symbolic link.

## Results

```ts
const result = await client.tools.run('faceBlurApi', { image: 'photo.jpg', params: { mode: 'auto' } })

result.image           // Buffer of the produced file (undefined if the tool only returns data)
result.data            // the data output, parsed JSON
result.cost            // credits charged
result.creditsBalance  // credits left
result.output('out')   // an output by key, or by name ('image', 'data', 'file')
for (const output of result.outputs) {
  console.log(output.key, output.name, output.contentType, output.content.length)
}
```

In a batch, output keys get the rank of the file: `out#0`, `out#1`… Each
`output.url` is a download link valid for one hour.

## Tools and settings

```ts
for (const tool of await client.tools.list({ executableOnly: true })) {
  console.log(tool.id, tool.inputs.map(i => i.id), tool.outputs.map(o => o.key))
}

const schema = await client.tools.schema('flip') // JSON Schema of the settings
await client.tools.run('flip', { image: 'photo.jpg', params: { axis: 'v' } })
```

Invalid settings reject with `InvalidRequestError`, with the reasons in `details`.

## Several files

A tool with several inputs takes `inputs`, keyed by input id. An input that
takes several files takes an array:

```ts
await client.tools.run('mask', { inputs: { image: 'photo.png', mask: 'mask.png' } })
await client.tools.run('merge', { inputs: { base: 'bg.png', overlay: ['1.png', '2.png'] } })
await client.tools.run('flip', { image: ['a.png', 'b.png', 'c.png'], params: { axis: 'h' } }) // 3 runs
```

When `tool.inputs[i].perFile` is true, each file is a separate run, charged
separately. A palette is passed in `params`, as an array of colors.

A file is a path (a string or a `file:` URL), a `Buffer` or any `Uint8Array`,
an `ArrayBuffer`, a `Blob` or `File`, or a readable stream (Node.js or web
streams, or any async iterable of bytes). To use a file from the web, pass a
`SourceURL`; a plain string is always a local path.

```ts
import { SourceURL } from 'pixlub'

await client.tools.run('removeBgApi', { image: new SourceURL('https://example.com/photo.jpg') })
```

Large files are handled automatically: call `run()` the same way. A stream is
copied to a temporary file first, so that its size is known; the copy is
deleted when the run ends.

## Limits

| Limit | Value |
| --- | --- |
| File size, by plan | Free 10 MiB, Basic 50 MiB, Pro 3 GiB |
| File size, by tool | images 1 GiB, video and audio 3 GiB, Office 250 MiB |
| Image size | 40 megapixels |
| Files per run | 64 |
| Runs | 30 a minute per account, bursts of 10 |
| Download links | 1 hour |
| Results the SDK downloads | 1 GiB per file, 4 GiB per run (larger: use the link) |

## Timeouts and cancellation

`run()` waits for long runs until they finish, up to `jobTimeout` (30 minutes
by default). After that, `JobTimeoutError` gives the `jobId`: the run may still
finish and may have been charged, so check it with `GET /v1/jobs/{jobId}`
rather than running the tool again.

Durations are in milliseconds. `timeout` is the longest wait for an answer, or
for the next bytes of a transfer: a large file that keeps moving never times out.

```ts
const client = new Pixlub({ timeout: 30_000, jobTimeout: 600_000 })
const result = await client.tools.run('removeBgApi', { image: 'photo.jpg', jobTimeout: 3_600_000 })
```

Every method takes a `signal` to cancel it, and then rejects with `AbortedError`:

```ts
const result = await client.tools.run('removeBgApi', {
  image: 'photo.jpg',
  signal: AbortSignal.timeout(120_000),
})
```

## Errors

API errors and refused arguments reject with a `PixlubError`. A wrong argument
type throws a `TypeError`; a file that `save()` cannot write rejects with the
Node.js error (`EEXIST` when the file exists).

| Error | When |
| --- | --- |
| `ConfigurationError` | Missing or malformed key, base URL or option. |
| `InvalidInputError` | An argument was refused before anything was sent. |
| `UnknownToolError` | Unknown tool id. |
| `InvalidRequestError` | HTTP 400 or 422: invalid settings (`details`), `image_too_large` (`maxPixels`)… |
| `FileTooLargeError` | HTTP 413: file too large for the tool or your plan (`maxBytes`). |
| `AuthenticationError` | HTTP 401: unknown or revoked key. |
| `InsufficientCreditsError` | HTTP 402: not enough credits (`requiredCredits`). |
| `PermissionDeniedError` | HTTP 403: not included in your plan (`code`, `limit`). |
| `NotFoundError` | HTTP 404. |
| `RateLimitError` | HTTP 429: too many requests (`retryAfter`). Never charged. |
| `ServerError`, `ServiceUnavailableError` | HTTP 5xx (`retryAfter`). |
| `APIConnectionError`, `APITimeoutError` | No answer (`requestSent`). |
| `JobTimeoutError` | A run outlived `jobTimeout` (`jobId`). |
| `AbortedError` | The call was cancelled through its `signal` (`cause`). |
| `UnexpectedResponseError` | The answer could not be read. |

Every `APIError` has `httpStatus`, `code` and `message`.

```ts
import { APIError, InsufficientCreditsError } from 'pixlub'

try {
  const result = await client.tools.run('removeBgApi', { image: 'photo.jpg' })
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    console.log('Top up your credits:', error.requiredCredits)
  } else if (error instanceof APIError) {
    console.log(`Refused (${error.httpStatus}): ${error.message}`)
  } else {
    throw error
  }
}
```

## Retries and credits

The SDK retries a request only when it cannot cause a second charge, up to
`maxRetries` times (2 by default, 0 to disable), and waits as long as the API
asks. Arguments are checked before anything is sent: a mistake costs nothing.
After a timeout or a server error on a run, check your balance before running
it again.

## Configuration

| Option | Environment variable | Default |
| --- | --- | --- |
| `apiKey` | `PIXLUB_API_KEY` | required |
| `baseURL` | `PIXLUB_BASE_URL` | `https://api.pixlub.com` (`http://` only for localhost) |
| `timeout` | | 180 000 ms |
| `jobTimeout` | | 1 800 000 ms (30 minutes) |
| `maxRetries` | | 2 (0 to 5) |
| `maxInputBytes` | | 3 GiB |
| `fetch` | | the global `fetch` (pass another one for proxies or custom TLS) |

For a proxy, pass a `fetch` bound to an [undici](https://undici.nodejs.org)
`ProxyAgent`:

```ts
import { fetch, ProxyAgent } from 'undici'

const dispatcher = new ProxyAgent('http://proxy.internal:3128')
const client = new Pixlub({ fetch: (url, init) => fetch(url, { ...init, dispatcher }) })
```

## Examples

[`examples/`](https://github.com/pixlub/pixlub-node/tree/main/examples):
`quickstart.mjs` for a first script, `batch.mjs` for many images at once.

## Development

```bash
npm ci
npm run check   # typecheck, tests, build, and an import/require check of the build
```

Live tests run against a real API, and running a tool costs credits:

```bash
PIXLUB_BASE_URL=https://api.pixlub.com PIXLUB_API_KEY=... npx vitest run test/live.test.ts
```

## License

MIT: see [LICENSE](https://github.com/pixlub/pixlub-node/blob/main/LICENSE).
