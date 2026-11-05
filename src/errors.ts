/** Errors thrown by the SDK. All extend {@link PixlubError}. */

/** Base class of every error thrown by the SDK. */
export class PixlubError extends Error {
  /** Id of the accepted run the error belongs to. The run may have been charged. */
  jobId: string | undefined = undefined

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** The API key or base URL is missing or invalid, or an option is out of range. */
export class ConfigurationError extends PixlubError {}

/** An argument was refused before anything was sent. */
export class InvalidInputError extends PixlubError {}

/** The tool id is unknown. */
export class UnknownToolError extends InvalidInputError {}

/**
 * The API could not be reached, or the connection broke.
 *
 * When `requestSent` is true, the run may have been charged: check your
 * balance before running it again.
 */
export class APIConnectionError extends PixlubError {
  readonly requestSent: boolean

  constructor(message: string, options: { requestSent: boolean }) {
    super(message)
    this.requestSent = options.requestSent
  }
}

/** The API did not answer within the configured timeout. */
export class APITimeoutError extends APIConnectionError {}

/** The run did not finish within `jobTimeout`. It may still finish, and was charged. */
export class JobTimeoutError extends APITimeoutError {
  constructor(message: string, options: { jobId: string }) {
    super(message, { requestSent: true })
    this.jobId = options.jobId
  }
}

/** The call was cancelled through its `signal`. `cause` holds the signal's reason. */
export class AbortedError extends PixlubError {}

/** The API answered with a success status, but not with the content the SDK expects. */
export class UnexpectedResponseError extends PixlubError {}

/** What the API sent with an error, when it sent it. */
export interface APIErrorFields {
  httpStatus: number
  /** Stable error code, such as `use_uploads` or `insufficient_credits`. */
  code?: string | undefined
  /** Validation details, such as the reasons settings were refused. */
  details?: unknown
  /** The error body as sent by the API. */
  body?: Record<string, unknown> | undefined
  /** Seconds to wait before trying again (429, 503). */
  retryAfter?: number | undefined
  /** Largest file accepted (HTTP 413). */
  maxBytes?: number | undefined
  /** Largest image accepted, in pixels (`image_too_large`). */
  maxPixels?: number | undefined
  /** The limit that was reached (`batch_limit`, `media_too_long`...). */
  limit?: number | undefined
  /** Credits the run needs (HTTP 402). */
  requiredCredits?: number | undefined
  /** When a quota resets (ISO 8601), as sent by the server. */
  resetAt?: string | undefined
}

/** The API answered with an error status. Its fields are undefined when the server did not send them. */
export class APIError extends PixlubError {
  readonly httpStatus: number
  readonly code: string | undefined
  readonly details: unknown
  readonly body: Record<string, unknown> | undefined
  readonly retryAfter: number | undefined
  readonly maxBytes: number | undefined
  readonly maxPixels: number | undefined
  readonly limit: number | undefined
  readonly requiredCredits: number | undefined
  readonly resetAt: string | undefined

  constructor(message: string, fields: APIErrorFields) {
    super(`${message} (HTTP ${fields.httpStatus}${fields.code ? `, code=${fields.code}` : ''})`)
    this.httpStatus = fields.httpStatus
    this.code = fields.code
    this.details = fields.details
    this.body = fields.body
    this.retryAfter = fields.retryAfter
    this.maxBytes = fields.maxBytes
    this.maxPixels = fields.maxPixels
    this.limit = fields.limit
    this.requiredCredits = fields.requiredCredits
    this.resetAt = fields.resetAt
  }
}

/** HTTP 4xx: the request was refused, e.g. invalid settings (see `details`). */
export class InvalidRequestError extends APIError {}

/** HTTP 413: a file is too large for the tool or your plan. `maxBytes` gives the limit. */
export class FileTooLargeError extends InvalidRequestError {}

/** HTTP 401: the API key is missing, unknown or revoked. */
export class AuthenticationError extends APIError {}

/** HTTP 403: the key is valid but the account may not do this, for example on a free plan. */
export class PermissionDeniedError extends APIError {}

/** HTTP 404: the tool, the upload or the job does not exist (see `code`). */
export class NotFoundError extends APIError {}

/** HTTP 402: the account does not have enough credits for this tool. */
export class InsufficientCreditsError extends APIError {}

/** HTTP 429: too many requests. `retryAfter` is the wait in seconds, when given. */
export class RateLimitError extends APIError {}

/** HTTP 5xx: something failed on the server side. */
export class ServerError extends APIError {}

/** HTTP 503: the service is busy or down for a while. `retryAfter` says for how long. */
export class ServiceUnavailableError extends ServerError {}
