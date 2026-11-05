// List the tools, then remove the background of an image.
//
//   export PIXLUB_API_KEY=pix....
//   node examples/quickstart.mjs photo.jpg

import { APIError, InsufficientCreditsError, Pixlub } from 'pixlub'

const [source] = process.argv.slice(2)
if (!source) {
  console.error('usage: node examples/quickstart.mjs <image>')
  process.exit(2)
}

const client = new Pixlub()
const tools = await client.tools.list({ executableOnly: true })
console.log(`${tools.length} tools available, for example: ${tools.slice(0, 5).map(tool => tool.id).join(', ')}`)

let result
try {
  result = await client.tools.run('removeBgApi', { image: source })
} catch (error) {
  if (error instanceof InsufficientCreditsError) console.error(`Not enough credits: ${error.message}`)
  else if (error instanceof APIError) console.error(`The API refused the run: ${error.message}`)
  else throw error
  process.exit(1)
}

const output = await result.save(`output${result.extension}`, { overwrite: true })
console.log(`Saved ${output} (${result.image.length} bytes)`)
if (result.creditsBalance !== undefined) console.log(`Credits left: ${result.creditsBalance}`)
