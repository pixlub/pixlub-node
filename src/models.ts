/** Objects returned by the SDK. */

import { InvalidInputError, UnexpectedResponseError } from './errors.js'
import { extensionFor, writeOutput } from './files.js'

/** A file input of a tool. `id` is the name to use with `inputs: { [id]: ... }`. */
export interface ToolInput {
  readonly id: string
  readonly label: string
  readonly required: boolean
  /** `image`, `channel` (read as grayscale) or `batch`. */
  readonly type: string
  readonly description: string
  /** True when the input takes several files: pass an array, such as `inputs: { [id]: [a, b] }`. */
  readonly multiple: boolean
  /** True when each file is a separate run, charged separately (a batch). */
  readonly perFile: boolean
  /** Most files this input takes in one call, for your plan. Undefined when not given. */
  readonly maxFiles: number | undefined
  /** Content types the input accepts, such as `['image/png', 'image/jpeg']`. */
  readonly accept: readonly string[]
}

/** An output a tool can produce, as described by the catalog. */
export interface ToolOutputSpec {
  /** Matches `ToolOutput.key` in a result. In a batch, the result keys get `#0`, `#1`... */
  readonly key: string
  readonly label: string
  readonly description: string
  /** What the output holds, such as `image`, `data` or `file`. */
  readonly kind: string
  readonly multiple: boolean
  readonly contentTypes: readonly string[]
}

/** A tool (module) from the catalog returned by `client.tools.list()`. */
export class Tool {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: string
  /** False when the tool cannot be run through the API. */
  readonly executable: boolean
  /** `local`, `remote` or `none`. */
  readonly handler: string
  readonly inputs: readonly ToolInput[]
  readonly outputs: readonly ToolOutputSpec[]

  constructor(fields: {
    id: string
    name: string
    description: string
    category: string
    executable: boolean
    handler: string
    inputs: readonly ToolInput[]
    outputs: readonly ToolOutputSpec[]
  }) {
    this.id = fields.id
    this.name = fields.name
    this.description = fields.description
    this.category = fields.category
    this.executable = fields.executable
    this.handler = fields.handler
    this.inputs = Object.freeze(fields.inputs.map(input => Object.freeze({ ...input })))
    this.outputs = Object.freeze(fields.outputs.map(output => Object.freeze({ ...output })))
    Object.freeze(this)
  }

  /** The main input, filled by a `SourceURL`: the first required one, else the first. */
  get primaryInput(): ToolInput | undefined {
    return this.inputs.find(input => input.required) ?? this.inputs[0]
  }
}

/** One file produced by a run, already downloaded from its signed link. */
export class ToolOutput {
  /** The tool output (see `Tool.outputs`); `out#0`, `out#1`... in a batch. Empty when not given. */
  readonly key: string
  /** `image`, `data` (JSON) or `file` (another format, such as a PDF). */
  readonly name: string
  /** Signed download link, valid until `ToolResult.expiresAt` (one hour). */
  readonly url: string
  readonly contentType: string
  readonly content: Buffer
  /** Size announced by the API, in bytes. */
  readonly bytes: number | undefined

  constructor(fields: {
    key: string
    name: string
    url: string
    contentType: string
    content: Buffer
    bytes: number | undefined
  }) {
    this.key = fields.key
    this.name = fields.name
    this.url = fields.url
    this.contentType = fields.contentType
    this.content = fields.content
    this.bytes = fields.bytes
    Object.freeze(this)
  }

  /** File extension matching the content type, such as `.png` or `.json`. */
  get extension(): string {
    return extensionFor(this.contentType)
  }

  /** The content parsed as JSON. Use it on the `data` output. */
  json(): unknown {
    try {
      return JSON.parse(this.content.toString('utf8'))
    } catch {
      throw new UnexpectedResponseError(`The '${this.key || this.name}' output is not valid JSON.`)
    }
  }

  /**
   * Writes the content to `path`, readable by its owner only, and resolves to `path`.
   * Refuses to replace a file unless `overwrite: true`, and never writes through a symbolic link.
   */
  save(path: string, options: { overwrite?: boolean } = {}): Promise<string> {
    return writeOutput(path, this.content, options.overwrite === true)
  }

  /** Keeps the content out of `console.log` and `util.inspect`. */
  [Symbol.for('nodejs.util.inspect.custom')](): object {
    const { key, name, url, contentType, bytes } = this
    return { key, name, url, contentType, bytes, content: `<${this.content.byteLength} bytes>` }
  }
}

/** What a run produced: `image`, `data`, and every file in `outputs`. */
export class ToolResult {
  readonly module: string
  readonly outputs: readonly ToolOutput[]
  /** Identifier of the run, useful when contacting support. */
  readonly id: string | undefined
  /** When the download links expire (ISO 8601). The files are deleted after 24 hours. */
  readonly expiresAt: string | undefined
  /** Credits charged for this run. */
  readonly cost: number | undefined
  /** Credits left on the account after this run. */
  readonly creditsBalance: number | undefined
  /** Optional note from the tool, such as a warning about the result. */
  readonly message: string | undefined

  constructor(fields: {
    module: string
    outputs: readonly ToolOutput[]
    id: string | undefined
    expiresAt: string | undefined
    cost: number | undefined
    creditsBalance: number | undefined
    message: string | undefined
  }) {
    this.module = fields.module
    this.outputs = Object.freeze([...fields.outputs])
    this.id = fields.id
    this.expiresAt = fields.expiresAt
    this.cost = fields.cost
    this.creditsBalance = fields.creditsBalance
    this.message = fields.message
    Object.freeze(this)
  }

  /**
   * The output with this key (such as `out` or `out#1`), or else the first one with
   * this name (`image`, `data` or `file`). Undefined when there is none.
   */
  output(keyOrName: string): ToolOutput | undefined {
    return this.outputs.find(item => item.key !== '' && item.key === keyOrName) ?? this.#named(keyOrName)
  }

  #named(name: string): ToolOutput | undefined {
    return this.outputs.find(item => item.name === name)
  }

  /** The produced file: the image, or else the first output that is not data. */
  get file(): ToolOutput | undefined {
    return this.#named('image') ?? this.outputs.find(item => item.name !== 'data')
  }

  /** Bytes of the produced file, or undefined when the tool only returns data. */
  get image(): Buffer | undefined {
    return this.file?.content
  }

  /** Content type of the produced file, such as `image/png`. */
  get contentType(): string | undefined {
    return this.file?.contentType
  }

  /** File extension of the produced file, such as `.png`; `.json` when there is only data. */
  get extension(): string {
    return this.file?.extension ?? '.json'
  }

  /** The `data` output parsed as JSON, or undefined when the tool returns none. */
  get data(): unknown {
    return this.#named('data')?.json()
  }

  /** Writes the produced file. Refuses to replace a file unless `overwrite: true`. */
  async save(path: string, options: { overwrite?: boolean } = {}): Promise<string> {
    const produced = this.file
    if (!produced) {
      throw new InvalidInputError('This run produced no file, only data: read result.data instead.')
    }
    return produced.save(path, options)
  }
}
