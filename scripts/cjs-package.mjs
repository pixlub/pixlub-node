// The CommonJS build lives next to an ESM package: mark its folder as CommonJS.
import { writeFileSync } from 'node:fs'

writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), JSON.stringify({ type: 'commonjs' }) + '\n')
