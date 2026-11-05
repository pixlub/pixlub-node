// Loads the built package the way users do, through import and require, and checks both.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const esm = await import('pixlub')
const cjs = require('pixlub')

const names = [
  'Pixlub',
  'SourceURL',
  'PixlubError',
  'APIError',
  'AbortedError',
  'FileTooLargeError',
  'JobTimeoutError',
  'Tool',
  'ToolResult',
  'ToolOutput',
  'VERSION',
  'DIRECT_UPLOAD_MAX_BYTES',
]
for (const [label, module] of [
  ['import', esm],
  ['require', cjs],
]) {
  for (const name of names) assert.ok(module[name] !== undefined, `${label}: ${name} is missing`)
  assert.equal(module.VERSION, manifest.version, `${label}: VERSION differs from package.json`)
  assert.equal(module.default, module.Pixlub, `${label}: the default export is not Pixlub`)
  const client = new module.Pixlub({ apiKey: 'pix.smoke.test', baseURL: 'http://localhost:1' })
  assert.equal(String(client), 'Pixlub(baseURL=http://localhost:1, apiKey=pix.smoke.***)')
  assert.throws(() => new module.SourceURL('http://example.com'), module.InvalidInputError)
  const error = new module.FileTooLargeError('too big', { httpStatus: 413 })
  assert.ok(error instanceof module.APIError && error instanceof module.PixlubError && error instanceof Error)
  assert.equal(error.name, 'FileTooLargeError')
}

console.log(`pixlub ${manifest.version}: import and require both load.`)
