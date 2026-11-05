/**
 * Official Node.js SDK for the Pixlub API.
 *
 * ```ts
 * import { Pixlub } from 'pixlub'
 *
 * const client = new Pixlub() // reads PIXLUB_API_KEY
 * const result = await client.tools.run('removeBgApi', { image: 'photo.jpg' })
 * await result.save(`photo-nobg${result.extension}`)
 * ```
 *
 * @packageDocumentation
 */

export { Pixlub, Tools } from './client.js'
export type { ClientOptions, ListOptions, RequestOptions, RunOptions } from './client.js'
export { API_KEY_ENV_VAR, BASE_URL_ENV_VAR, DEFAULT_BASE_URL } from './config.js'
export { DIRECT_UPLOAD_MAX_BYTES, MAX_INPUT_FILES } from './core.js'
export {
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
  JobTimeoutError,
  NotFoundError,
  PermissionDeniedError,
  PixlubError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  UnexpectedResponseError,
  UnknownToolError,
} from './errors.js'
export type { APIErrorFields } from './errors.js'
export { SourceURL } from './files.js'
export type { FileSource, ImageSource, InputValue } from './files.js'
export type { Fetch } from './http.js'
export { Tool, ToolOutput, ToolResult } from './models.js'
export type { ToolInput, ToolOutputSpec } from './models.js'
export { VERSION } from './version.js'

export { Pixlub as default } from './client.js'
