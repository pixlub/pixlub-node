// Run one tool on many images, a few at a time.
//
//   node examples/batch.mjs out/ photo1.jpg photo2.jpg photo3.jpg
//
// At most CONCURRENCY runs at once. A failed image is reported and the others carry on.

import { mkdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { Pixlub, PixlubError } from 'pixlub'

const TOOL = 'removeBgApi'
const CONCURRENCY = 4

const [outDir, ...sources] = process.argv.slice(2)
if (!outDir || !sources.length) {
  console.error('usage: node examples/batch.mjs <out-dir> <image> [<image> ...]')
  process.exit(2)
}

async function processOne(client, index, source) {
  try {
    const result = await client.tools.run(TOOL, { image: source })
    // The index keeps two inputs with the same file name from overwriting each other.
    const stem = basename(source, extname(source))
    const target = join(outDir, `${String(index).padStart(3, '0')}-${stem}-${TOOL}${result.extension}`)
    await result.save(target, { overwrite: true })
    return `ok ${basename(source)} -> ${target}`
  } catch (error) {
    if (error instanceof PixlubError) return `FAILED ${basename(source)}: ${error.message}`
    throw error
  }
}

await mkdir(outDir, { recursive: true })
const client = new Pixlub()
const lines = new Array(sources.length)
let next = 0
async function worker() {
  while (next < sources.length) {
    const index = next++
    lines[index] = await processOne(client, index + 1, sources[index])
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker))
console.log(lines.join('\n'))
