/** Input files and streamed request bodies. */

import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { InvalidInputError } from './errors.js'

export const DEFAULT_MAX_INPUT_BYTES = 3 * 1024 * 1024 * 1024
export const CHUNK_SIZE = 256 * 1024
export const SOURCE_URL_MAX_LENGTH = 2048

const UNSAFE_FILENAME_CHARS = /[\x00-\x1f\x7f"\\]/g
const URL_FORBIDDEN_CHARS = /[\x00-\x20\x7f]/

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/avif': '.avif',
  'application/json': '.json',
  'application/pdf': '.pdf',
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/x-wav',
  '.ogg': 'audio/ogg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
}

/**
 * A public `https` URL to use as the tool's main input, instead of a local file:
 *
 * ```ts
 * await client.tools.run('removeBgApi', { image: new SourceURL('https://example.com/a.jpg') })
 * ```
 *
 * A plain string is always a local path. The URL must use https on port 443,
 * carry no credentials and be at most 2048 characters long.
 */
export class SourceURL {
  readonly url: string

  constructor(url: string) {
    this.url = checkSourceUrl(url)
    Object.freeze(this)
  }

  toString(): string {
    return this.url
  }
}

/** A local file: a path (string or `file:` URL), bytes, a Blob or File, or a stream of bytes. */
export type FileSource =
  | string
  | URL
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | NodeJS.ReadableStream
  | AsyncIterable<Uint8Array>

/** A file, or a {@link SourceURL} for the tool's main input. */
export type ImageSource = FileSource | SourceURL

/** One file, or a list of files for an input that takes several. */
export type InputValue = ImageSource | readonly ImageSource[]

export function checkSourceUrl(url: unknown): string {
  if (typeof url !== 'string') throw new InvalidInputError('SourceURL takes the address as a string.')
  const text = url.trim()
  if (!text || text.length > SOURCE_URL_MAX_LENGTH) {
    throw new InvalidInputError(`A source URL must be 1 to ${SOURCE_URL_MAX_LENGTH} characters long.`)
  }
  if (URL_FORBIDDEN_CHARS.test(text)) {
    throw new InvalidInputError('A source URL must not contain spaces or control characters.')
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new InvalidInputError('Invalid source URL.')
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new InvalidInputError('A source URL must start with https:// and name a host.')
  }
  // URL drops the default port, so only another port remains here.
  if (parsed.port !== '') {
    throw new InvalidInputError('A source URL must use the standard https port (443).')
  }
  if (parsed.username || parsed.password || /^https:\/\/[^/?#]*@/i.test(text)) {
    throw new InvalidInputError('A source URL must not carry credentials.')
  }
  return text
}

export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType] ?? '.img'
}

export function sniffContentType(data: Uint8Array): string | undefined {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 16))
  const starts = (bytes: number[], offset = 0): boolean =>
    head.length >= offset + bytes.length && bytes.every((byte, i) => head[offset + i] === byte)
  const ascii = (text: string, offset = 0): boolean => starts([...Buffer.from(text, 'latin1')], offset)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii('GIF87a') || ascii('GIF89a')) return 'image/gif'
  if (ascii('RIFF') && ascii('WEBP', 8)) return 'image/webp'
  if (ascii('BM')) return 'image/bmp'
  if (starts([0x49, 0x49, 0x2a, 0x00]) || starts([0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'
  if (ascii('ftyp', 4) && (ascii('avif', 8) || ascii('avis', 8))) return 'image/avif'
  return undefined
}

type Content =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'path'; path: string; temporary?: string }
  | { kind: 'blob'; blob: Blob }

/** A file read and measured before anything is sent. */
export class PreparedFile {
  readonly formName: string
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly #content: Content

  constructor(formName: string, filename: string, contentType: string, size: number, content: Content) {
    this.formName = formName
    this.filename = filename
    this.contentType = contentType
    this.size = size
    this.#content = content
  }

  async close(): Promise<void> {
    const content = this.#content
    if (content.kind === 'path' && content.temporary) {
      await rm(content.temporary, { recursive: true, force: true })
    }
  }

  /** The bytes, in chunks. Fails with InvalidInputError when the file shrank meanwhile. */
  async *chunks(): AsyncGenerator<Uint8Array> {
    const content = this.#content
    if (content.kind === 'data') {
      for (let offset = 0; offset < this.size; offset += CHUNK_SIZE) {
        yield content.data.subarray(offset, Math.min(offset + CHUNK_SIZE, this.size))
      }
      return
    }
    if (content.kind === 'blob') {
      const reader = content.blob.stream().getReader()
      try {
        let sent = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) throw this.#shorter()
          const part = value.subarray(0, Math.max(0, this.size - sent))
          sent += part.byteLength
          if (part.byteLength) yield part
          if (sent >= this.size) return
        }
      } catch (error) {
        if (error instanceof InvalidInputError) throw error
        throw new InvalidInputError(`Cannot read input '${this.formName}': ${(error as Error)?.message ?? error}.`)
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    }
    let handle: FileHandle
    try {
      handle = await open(content.path, 'r')
    } catch (error) {
      throw new InvalidInputError(`Cannot read input '${this.formName}': ${reason(error)}.`)
    }
    try {
      let remaining = this.size
      while (remaining > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, remaining))
        let bytesRead: number
        try {
          ;({ bytesRead } = await handle.read(buffer, 0, buffer.length, null))
        } catch (error) {
          throw new InvalidInputError(`Cannot read input '${this.formName}': ${reason(error)}.`)
        }
        if (bytesRead === 0) throw this.#shorter()
        remaining -= bytesRead
        yield buffer.subarray(0, bytesRead)
      }
    } finally {
      await handle.close()
    }
  }

  #shorter(): InvalidInputError {
    return new InvalidInputError(
      `Input '${this.formName}' got shorter than its ${this.size} bytes while it was being sent.`,
    )
  }
}

export async function prepareFile(source: unknown, formName: string, maxBytes: number): Promise<PreparedFile> {
  const label = `Input '${formName}'`
  if (source instanceof SourceURL) {
    throw new InvalidInputError(`${label}: a SourceURL can only fill the tool's main input.`)
  }
  if (typeof source === 'string' || source instanceof URL) {
    return preparePath(pathOf(source), formName, maxBytes)
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const data =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    checkSize(label, data.byteLength, maxBytes)
    return prepared(formName, '', data.subarray(0, 16), '', data.byteLength, { kind: 'data', data })
  }
  if (source instanceof Blob) {
    checkSize(label, source.size, maxBytes)
    const head = new Uint8Array(await source.slice(0, 16).arrayBuffer())
    const name = typeof (source as { name?: unknown }).name === 'string' ? (source as File).name : ''
    return prepared(formName, basename(name), head, source.type, source.size, { kind: 'blob', blob: source })
  }
  if (isByteStream(source)) {
    const path = (source as { path?: unknown }).path
    const name = typeof path === 'string' ? basename(path) : ''
    return prepareStream(source, formName, name, maxBytes)
  }
  const kind = source === null ? 'null' : typeof source === 'object' ? source.constructor?.name : typeof source
  throw new TypeError(
    'A file must be a path, bytes, a Blob, a readable stream or a SourceURL, ' + `not ${kind ?? 'object'}.`,
  )
}

function pathOf(source: string | URL): string {
  if (typeof source === 'string') {
    if (!source) throw new InvalidInputError('An empty string is not a file path.')
    return source
  }
  if (source.protocol !== 'file:') {
    throw new InvalidInputError('Only file: URLs are local files. Pass a remote file as new SourceURL(url).')
  }
  try {
    return fileURLToPath(source)
  } catch {
    throw new InvalidInputError('Invalid file: URL.')
  }
}

async function preparePath(path: string, formName: string, maxBytes: number): Promise<PreparedFile> {
  let head: Uint8Array
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new InvalidInputError(`${path} is not a regular file.`)
    size = info.size
    if (size === 0) throw new InvalidInputError(`${path} is empty.`)
    if (size > maxBytes) throw new InvalidInputError(`${path} is ${size} bytes; the limit is ${maxBytes} bytes.`)
    const handle = await open(path, fsConstants.O_RDONLY)
    try {
      const buffer = Buffer.alloc(16)
      const { bytesRead } = await handle.read(buffer, 0, 16, 0)
      head = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof InvalidInputError) throw error
    throw new InvalidInputError(`Cannot read ${path}: ${reason(error)}.`)
  }
  return prepared(formName, basename(path), head, '', size, { kind: 'path', path })
}

function isByteStream(source: unknown): source is AsyncIterable<unknown> {
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

async function prepareStream(
  stream: AsyncIterable<unknown>,
  formName: string,
  filename: string,
  maxBytes: number,
): Promise<PreparedFile> {
  const label = `Input '${formName}'`
  const folder = await mkdtemp(join(tmpdir(), 'pixlub-'))
  const path = join(folder, 'input')
  let size = 0
  const head: Uint8Array[] = []
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Streams must yield bytes (Buffer or Uint8Array), not text: do not set an encoding.')
        }
        if (size < 16) head.push(chunk.subarray(0, 16 - size))
        const room = maxBytes + 1 - size
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
        await handle.write(part)
        size += part.byteLength
        if (size > maxBytes) break
      }
    } finally {
      await handle.close()
    }
    checkSize(label, size, maxBytes)
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
  return prepared(formName, filename, Buffer.concat(head), '', size, { kind: 'path', path, temporary: folder })
}

function checkSize(label: string, size: number, maxBytes: number): void {
  if (size <= 0) throw new InvalidInputError(`${label} is empty.`)
  if (size > maxBytes) throw new InvalidInputError(`${label} is ${size} bytes; the limit is ${maxBytes} bytes.`)
}

function prepared(
  formName: string,
  filename: string,
  head: Uint8Array,
  declaredType: string,
  size: number,
  content: Content,
): PreparedFile {
  const contentType =
    sniffContentType(head) ??
    CONTENT_TYPES[extname(filename).toLowerCase()] ??
    (validType(declaredType) ? declaredType.toLowerCase() : undefined) ??
    'application/octet-stream'
  let name = filename.replace(UNSAFE_FILENAME_CHARS, '_').trim()
  if (!name) name = `${formName}${extensionFor(contentType)}`
  return new PreparedFile(formName, name, contentType, size, content)
}

function validType(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/.test(value)
}

function reason(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  const messages: Record<string, string> = {
    ENOENT: 'No such file or directory',
    EACCES: 'Permission denied',
    EISDIR: 'Is a directory',
    ELOOP: 'Too many levels of symbolic links',
    ENAMETOOLONG: 'File name too long',
    ENOTDIR: 'Not a directory',
  }
  if (typeof code === 'string') return messages[code] ?? code
  return 'unknown error'
}

/** A request body of known length, sent in chunks. */
export interface Body {
  readonly contentType: string
  readonly length: number
  chunks(): AsyncGenerator<Uint8Array>
}

export class BytesBody implements Body {
  readonly length: number
  readonly #data: Uint8Array

  constructor(
    data: Uint8Array,
    readonly contentType: string,
  ) {
    this.#data = data
    this.length = data.byteLength
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    yield this.#data
  }
}

export class FileBody implements Body {
  readonly contentType: string
  readonly length: number

  constructor(readonly file: PreparedFile) {
    this.contentType = file.contentType
    this.length = file.size
  }

  chunks(): AsyncGenerator<Uint8Array> {
    return this.file.chunks()
  }
}

export class MultipartBody implements Body {
  readonly contentType: string
  readonly length: number
  readonly #parts: (Uint8Array | PreparedFile)[] = []

  constructor(fields: readonly (readonly [string, string])[], files: readonly PreparedFile[]) {
    const boundary = randomBytes(16).toString('hex')
    this.contentType = `multipart/form-data; boundary=${boundary}`
    for (const [name, value] of fields) {
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`
      this.#parts.push(Buffer.from(`${head}${value}\r\n`))
    }
    for (const file of files) {
      const head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.formName}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`
      this.#parts.push(Buffer.from(head), file, Buffer.from('\r\n'))
    }
    this.#parts.push(Buffer.from(`--${boundary}--\r\n`))
    this.length = this.#parts.reduce((sum, part) => sum + (part instanceof PreparedFile ? part.size : part.byteLength), 0)
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    for (const part of this.#parts) {
      if (part instanceof PreparedFile) yield* part.chunks()
      else yield part
    }
  }
}

/** Writes `content` to `path`, readable by its owner only. Refuses to replace a file unless `overwrite`. */
export async function writeOutput(path: string, content: Uint8Array, overwrite: boolean): Promise<string> {
  if (overwrite) {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new InvalidInputError(`${path} is a symbolic link, and the SDK does not write through links.`)
      }
    } catch (error) {
      if (error instanceof InvalidInputError) throw error
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
  }
  const handle = await open(path, overwrite ? 'w' : 'wx', 0o600)
  try {
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
  return path
}
