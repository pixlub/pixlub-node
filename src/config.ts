/** API key and base URL. */

import { ConfigurationError } from './errors.js'

export const API_KEY_ENV_VAR = 'PIXLUB_API_KEY'
export const BASE_URL_ENV_VAR = 'PIXLUB_BASE_URL'
export const DEFAULT_BASE_URL = 'https://api.pixlub.com'

const API_KEY_RE = /^pix\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,256}$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function resolveApiKey(apiKey: string | undefined): string {
  const raw = apiKey !== undefined ? apiKey : process.env[API_KEY_ENV_VAR]
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!key) {
    throw new ConfigurationError(
      `No API key provided. Pass { apiKey } or set the ${API_KEY_ENV_VAR} environment variable.`,
    )
  }
  if (!API_KEY_RE.test(key)) {
    throw new ConfigurationError(
      'The API key is malformed. Copy the whole key (pix.<prefix>.<secret>) from your dashboard.',
    )
  }
  return key
}

export function resolveBaseUrl(baseURL: string | undefined): string {
  const raw = baseURL !== undefined ? baseURL : process.env[BASE_URL_ENV_VAR]
  const text = (raw || DEFAULT_BASE_URL).trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ConfigurationError('Invalid base URL. Expected a form like https://api.example.com')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
    throw new ConfigurationError('The base URL must start with http:// or https:// and name a host.')
  }
  if (url.username || url.password) {
    throw new ConfigurationError('Do not put credentials in the base URL. Use { apiKey } instead.')
  }
  if (url.search || url.hash || text.includes('?') || text.includes('#')) {
    throw new ConfigurationError('The base URL must not contain a query string or a fragment.')
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigurationError(
      'Plain http:// is only accepted for localhost. Use https:// so your API key is encrypted in transit.',
    )
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/** A link sent by the API (result, upload), made absolute and checked before use. */
export function resolveLink(link: unknown, baseUrl: string): string {
  if (typeof link !== 'string' || !link.trim()) throw new Error('empty link')
  let url: URL
  try {
    url = new URL(link.trim(), `${baseUrl}/`)
  } catch {
    throw new Error('link is not a valid URL')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
    throw new Error('link is not an http(s) URL')
  }
  if (url.username || url.password) throw new Error('link carries credentials')
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('link uses plain http outside localhost')
  }
  return url.href
}

export function keyMask(apiKey: string): string {
  return `pix.${apiKey.split('.')[1]}.***`
}

export function redact(text: string, apiKey: string): string {
  return text.split(apiKey).join(keyMask(apiKey))
}
