/**
 * Tavily-compatible search provider for the DeepSeek Harness web capability seam (`ctx.web`).
 *
 * One provider, three wire protocols, one configurable endpoint:
 *
 * - `tavily`            — Tavily's own REST shape, `POST {base}/search`.
 * - `openai-responses`  — an OpenAI-compatible Responses API with the native `web_search` tool,
 *                         `POST {base}/responses`.
 * - `openai-chat`       — an OpenAI-compatible Chat Completions endpoint that returns citations,
 *                         `POST {base}/chat/completions`.
 *
 * The endpoint, credential, and auth style are all configuration, so a relay or gateway domain
 * works exactly like the official one. The provider deliberately imports nothing from the host
 * packages except the Config schema factory: the running host resolves `@deepseek-ai/*` from the
 * shared profile store, which may be a different build than the one serving this plugin, and
 * class identity across those builds is not guaranteed. Errors therefore carry the seam's
 * machine-routable `code` as a plain property rather than as a `WebError` subclass.
 *
 * @module dsh-web-search-tavily
 */

let z
try {
  ({ default: z } = await import('@deepseek-ai/schemastery'))
} catch {
  z = undefined
}

/**
 * Mark one schema field as a live configuration reference.
 *
 * `@deepseek-ai/schemastery` gained `Schema.prototype.volatile()` in 3.18.4, and the running Host
 * supplies its own copy of that package for every peer a plugin declares — so the method is
 * normally present. The fallback marks the same metadata directly, which keeps the module
 * importable (and the plugin loadable) if an older copy is ever resolved instead; the settings
 * projection reads the metadata, so the form still renders either way.
 *
 * @param schema - the field schema.
 * @returns the schema marked volatile.
 */
function editable(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  return schema.extra('volatile', true)
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-tavily/0.1.0'

/** Protocol identifiers accepted by the `protocol` field, with their aliases. */
const PROTOCOLS = {
  tavily: 'tavily',
  tavily_rest: 'tavily',
  rest: 'tavily',
  'openai-responses': 'openai-responses',
  openai_responses: 'openai-responses',
  responses: 'openai-responses',
  'openai-chat': 'openai-chat',
  openai_chat: 'openai-chat',
  chat: 'openai-chat',
  'chat-completions': 'openai-chat',
}

/** Auth styles accepted by the `authStyle` field. */
const AUTH_STYLES = ['auto', 'bearer', 'body', 'header', 'none']

/** Per-protocol endpoint suffix appended to a configured base URL. */
const ENDPOINT_SUFFIX = {
  tavily: '/search',
  'openai-responses': '/responses',
  'openai-chat': '/chat/completions',
}

/** Endpoint used when the configuration names none. */
const DEFAULT_BASE_URL = {
  tavily: 'https://api.tavily.com',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-chat': 'https://api.openai.com/v1',
}

/** Official Tavily origin, the only host that accepts the keyless access mode. */
const TAVILY_OFFICIAL_ORIGIN = 'https://api.tavily.com'

/** Credential reference resolved when the configuration names none. */
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/**
 * The plugin Config schema.
 *
 * Every field a settings page may edit is marked volatile, because the Host projects only
 * volatile fields into a settings form and refuses writes outside them. `providerId`, the
 * domain filters, and the raw-content switch stay ordinary: they are read once at mount and
 * belong in the profile's YAML rather than in a live form.
 *
 * Boolean switches a form edits are declared as `"true"`/`"false"` strings: a settings form's
 * text control always stages a string, and a schema-typed boolean would reject it on save.
 */
export const Config = z === undefined ? undefined : z.object({
  /** Registry key this provider registers under; must match `web.searchProvider`. */
  providerId: z.string().default('tavily'),
  /** Wire protocol: `tavily`, `openai-responses`, or `openai-chat`. */
  protocol: editable(z.string().default('tavily')),
  /** Endpoint base; the protocol's path is appended unless the value already ends with it. */
  baseURL: editable(z.string()),
  /** Literal API key. Prefer `apiKeyEnv` so no secret enters the settings document. */
  apiKey: editable(z.string().role('secret')),
  /** Credential reference resolved through `ctx.credentials`, then the launch environment. */
  apiKeyEnv: editable(z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV)),
  /** How the key is presented: `auto`, `bearer`, `body`, `header`, or `none`. */
  authStyle: editable(z.string().default('auto')),
  /** Header name for `authStyle: header`. */
  authHeader: editable(z.string()),
  /** Prefix placed before the key for `bearer` and `header`; empty sends the key bare. */
  authScheme: editable(z.string().default('Bearer')),
  /** Model name for the OpenAI-compatible protocols. */
  model: editable(z.string()),
  /** Tavily `search_depth`: `basic`, `advanced`, `fast`, or `ultra-fast`. */
  searchDepth: editable(z.string().default('basic')),
  /** Tavily `topic`. */
  topic: editable(z.string().default('general')),
  /** Upper bound on results requested from the provider. */
  maxResults: editable(z.number().step(1).min(1).default(5)),
  /** Ask Tavily for a synthesized answer, surfaced as the result's `content`. */
  includeAnswer: editable(z.string().default('false')),
  /** Ask Tavily for `raw_content` as well; the seam's source shape has no slot for full page text, so it only backs a missing snippet. */
  includeRawContent: z.boolean().default(false),
  /** Domains Tavily should restrict results to. */
  includeDomains: z.array(z.string()).default([]),
  /** Domains Tavily should exclude. */
  excludeDomains: z.array(z.string()).default([]),
  /**
   * Catch-all request-body fields, merged last.
   *
   * Mirrors the official Tavily MCP's `DEFAULT_PARAMETERS`: one JSON object covering every search
   * parameter, so a parameter Tavily adds later needs no plugin change. A settings form stages a
   * string; a profile's YAML may write the object directly, so both shapes are accepted.
   */
  defaultParameters: editable(z.union([z.string(), z.dict(z.any())])),
  /** Responses-API tool type; gateways differ between `web_search` and `web_search_preview`. */
  responsesToolType: z.string().default('web_search'),
  /** Send `web_search_options` on Chat Completions requests. */
  chatWebSearchOptions: z.boolean().default(true),
  /** Request timeout in milliseconds. */
  timeoutMs: editable(z.number().step(1).min(1).default(30000)),
  /** Extra request headers, merged last. */
  extraHeaders: z.dict(z.string()).default({}),
})

/**
 * Read one configuration value.
 *
 * A volatile field is a live reference whose value the loader commits in place; an ordinary
 * field is the plain value. Reading through this helper keeps both shapes working, and keeps
 * the plugin loadable even when the Config schema could not be built.
 *
 * @param field - the schema field, a volatile reference, or undefined.
 * @param fallback - value used when the field is absent or undefined.
 * @returns the current value.
 */
function read(field, fallback) {
  if (field === undefined || field === null) return fallback
  const value = typeof field.get === 'function' ? field.get() : field
  return value === undefined ? fallback : value
}

/** True for a non-empty string after trimming. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** Parse a `"true"`/`"false"` style switch. */
function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  return fallback
}

/** Normalize a protocol name, or undefined when it is not recognized. */
function normalizeProtocol(value) {
  if (!nonEmpty(value)) return 'tavily'
  return PROTOCOLS[value.trim().toLowerCase()]
}

/**
 * Build the request URL for one operation.
 *
 * A configured base URL is used as given when it already ends with the protocol's path, so a
 * deployment may configure either a base (`https://relay.example/v1`) or a full endpoint
 * (`https://relay.example/tavily/search`).
 *
 * @param protocol - the normalized protocol.
 * @param baseURL - the configured base, possibly empty.
 * @returns the absolute endpoint URL.
 */
function resolveEndpoint(protocol, baseURL) {
  const suffix = ENDPOINT_SUFFIX[protocol]
  const base = nonEmpty(baseURL) ? baseURL.trim().replace(/\/+$/u, '') : DEFAULT_BASE_URL[protocol]
  if (base.endsWith(suffix)) return base
  return `${base}${suffix}`
}

/** Build a `WEB_PROVIDER_ERROR` carrying the seam's machine-routable code. */
function providerError(message, cause) {
  const error = new Error(message)
  error.code = 'WEB_PROVIDER_ERROR'
  if (cause !== undefined) error.cause = cause
  return error
}

/** Build the seam's cancellation error, retaining the caller's reason. */
function abortedError(signal, fallback) {
  const error = new Error('Tavily search aborted')
  error.code = 'WEB_ABORTED'
  error.cause = signal?.aborted === true ? signal.reason : fallback
  return error
}

/** Build the seam's missing-credential error. */
function credentialError(apiKeyEnv, endpoint) {
  const error = new Error(
    `Tavily search has no API key for "${apiKeyEnv}" at ${JSON.stringify(endpoint)}. `
    + 'Store it through the credentials service (the Web Plugins page writes it), set a literal '
    + '"apiKey" in the web-search-tavily config, export the variable in the environment DSH was '
    + 'launched from, or set authStyle to "none" for an endpoint that needs no key.',
  )
  error.code = 'WEB_PROVIDER_CREDENTIAL_MISSING'
  return error
}

/** True for an abort raised by a fetch `AbortSignal`. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Race a promise against the caller's cancellation signal. */
function abortable(operation, signal) {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(abortedError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The Tavily-compatible search provider.
 *
 * Options are captured through a thunk so that one search never mixes two settings revisions:
 * the settings page can change the endpoint or the key between two searches, and re-registering
 * the provider to carry a new endpoint would surface as a flicker in the seam's selection.
 */
export class TavilySearchProvider {
  /**
   * @param id - the registry key this provider registers under.
   * @param resolveOptions - reads the options for the NEXT operation.
   */
  constructor(id, resolveOptions) {
    this.id = id
    this.resolveOptions = resolveOptions
  }

  /**
   * Whether the provider can serve a search right now.
   *
   * A missing credential cannot be detected synchronously when it lives behind an asynchronous
   * credential store, so this reports what the seam's selection rules need: a usable endpoint,
   * a recognized protocol, and either a resolvable credential or a protocol whose endpoint may
   * be called without one.
   */
  available() {
    const options = this.resolveOptions()
    if (options.protocol === undefined) return false
    if (!URL.canParse(options.endpoint)) return false
    if (options.authStyle === 'none') return true
    if (nonEmpty(options.apiKey)) return true
    return options.resolveApiKey !== undefined
  }

  /**
   * Run one search through the configured protocol.
   *
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded by the seam.
   * @returns normalized sources, plus the provider's answer when one was requested.
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    if (options.protocol === undefined) {
      throw providerError(`Tavily search does not recognize protocol ${JSON.stringify(options.rawProtocol)}; `
        + 'use "tavily", "openai-responses", or "openai-chat"')
    }
    if (options.defaultParametersError !== undefined) {
      throw providerError(`${options.defaultParametersError} — correct the "defaultParameters" field `
        + 'on the plugin configuration page (Plugins > dsh-web-search-tavily).')
    }
    const apiKey = await this.apiKey(options, signal)
    const headers = buildHeaders(options, apiKey)
    const body = buildBody(options, request, apiKey)
    if (signal?.aborted === true) throw abortedError(signal)

    const timeout = AbortSignal.timeout(options.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response
    try {
      response = await fetch(options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
      if (timeout.aborted) {
        throw providerError(
          `Tavily search timed out after ${options.timeoutMs}ms at ${JSON.stringify(options.endpoint)}. `
          + 'Raise timeoutMs on the plugin configuration page, or point baseURL at an endpoint that answers sooner.',
          error,
        )
      }
      throw providerError(
        `Tavily search request to ${JSON.stringify(options.endpoint)} failed: ${String(error)}`,
        error,
      )
    }

    if (!response.ok) throw await httpError(response, options, signal)

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
      throw providerError(
        `Tavily search received an unprocessable response body from ${JSON.stringify(options.endpoint)}: ${String(error)}`,
        error,
      )
    }

    try {
      return mapResponse(options.protocol, payload)
    } catch (error) {
      throw providerError(
        `Tavily search could not read the ${options.protocol} response from ${JSON.stringify(options.endpoint)}: ${String(error)}`,
        error,
      )
    }
  }

  /**
   * Resolve one operation's API key without retaining it on the provider.
   *
   * @param options - the caller's snapshot, so the key and the endpoint come from one revision.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key, or undefined when the endpoint needs none.
   */
  async apiKey(options, signal) {
    if (nonEmpty(options.apiKey)) return options.apiKey.trim()
    if (options.authStyle === 'none') return undefined
    if (options.resolveApiKey === undefined) {
      if (options.optionalCredential) return undefined
      throw credentialError(options.apiKeyEnv, options.endpoint)
    }
    let resolved
    try {
      resolved = await abortable(Promise.resolve(options.resolveApiKey()), signal)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
      throw providerError(`Tavily search credential resolution failed: ${String(error)}`, error)
    }
    if (nonEmpty(resolved)) return resolved.trim()
    if (options.optionalCredential) return undefined
    throw credentialError(options.apiKeyEnv, options.endpoint)
  }
}

/** Turn a non-2xx response into the seam's provider error, quoting the endpoint's own message. */
async function httpError(response, options, signal) {
  const status = response.status
  let message = `Tavily search endpoint ${JSON.stringify(options.endpoint)} answered HTTP ${status}`
  try {
    const text = await response.text()
    const detail = detailOf(text)
    if (detail !== undefined) message += `: ${detail}`
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
  }
  if (status === 401 || status === 403) {
    message += `\n\nThe endpoint rejected the credential. Check the API key and authStyle on the plugin `
      + 'configuration page (Settings > Plugins, or the Plugins page), and confirm the key belongs to '
      + `the account serving ${JSON.stringify(options.endpoint)}.`
  } else if (status === 429) {
    message += '\n\nThe endpoint reported a rate or quota limit; retry later or use another key.'
  } else if (status === 404) {
    message += '\n\nThe endpoint path may be wrong: a relay usually exposes Tavily under a different '
      + 'prefix than the official host, and an OpenAI-compatible gateway needs protocol "openai-chat" '
      + 'or "openai-responses".'
  }
  return providerError(message)
}

/** Extract a human-readable message from an error body that may be JSON or plain text. */
function detailOf(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    const detail = parsed?.error?.message ?? parsed?.error?.detail ?? parsed?.detail ?? parsed?.error ?? parsed?.message
    if (typeof detail === 'string' && detail.length > 0) return detail
    if (detail !== undefined) return JSON.stringify(detail)
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}

/**
 * Build the request headers for one operation.
 *
 * @param options - the operation's snapshot.
 * @param apiKey - the resolved key, or undefined.
 * @returns the headers to send.
 */
function buildHeaders(options, apiKey) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...options.extraHeaders,
  }
  const scheme = nonEmpty(options.authScheme) ? `${options.authScheme.trim()} ` : ''
  const style = options.authStyle
  if (nonEmpty(apiKey)) {
    if (style === 'header') {
      if (nonEmpty(options.authHeader)) headers[options.authHeader.trim()] = `${scheme}${apiKey}`
      else headers.authorization = `${scheme}${apiKey}`
    } else if (style !== 'body' && style !== 'none') {
      headers.authorization = `${scheme}${apiKey}`
    }
  } else if (options.protocol === 'tavily' && options.endpoint.startsWith(TAVILY_OFFICIAL_ORIGIN)) {
    // Tavily's keyless tier: an explicit marker, plus the client source it asks callers to send.
    headers['x-tavily-access-mode'] = 'keyless'
    headers['x-client-source'] = 'dsh-web-search-tavily'
  }
  return headers
}

/**
 * Build the request body for one operation, then apply the configured catch-all fields.
 *
 * `defaultParameters` merges last, exactly as the official Tavily MCP applies `DEFAULT_PARAMETERS`
 * over its own tool arguments, so it can reach any parameter this plugin does not model. The
 * caller's `query` is the one field it cannot replace: a search whose subject came from
 * configuration rather than from the model would be a silent, confusing failure.
 *
 * @param options - the operation's snapshot.
 * @param request - the caller's query and optional result bound.
 * @param apiKey - the resolved key, or undefined.
 * @returns the JSON body to send.
 */
function buildBody(options, request, apiKey) {
  const body = protocolBody(options, request, apiKey)
  for (const [key, value] of Object.entries(options.defaultParameters)) {
    if (key === 'query') continue
    body[key] = value
  }
  return body
}

/**
 * Build the protocol's own request body, before the catch-all fields are merged over it.
 *
 * @param options - the operation's snapshot.
 * @param request - the caller's query and optional result bound.
 * @param apiKey - the resolved key, or undefined.
 * @returns the JSON body for the configured protocol.
 */
function protocolBody(options, request, apiKey) {
  const limit = Number.isInteger(request.maxResults) && request.maxResults > 0
    ? Math.min(request.maxResults, options.maxResults)
    : options.maxResults
  const bodyAuth = nonEmpty(apiKey) && options.authStyle === 'body'
  if (options.protocol === 'tavily') {
    const body = {
      query: request.query,
      search_depth: options.searchDepth,
      topic: options.topic,
      max_results: limit,
      include_answer: options.includeAnswer,
      include_raw_content: options.includeRawContent,
      include_domains: options.includeDomains,
      exclude_domains: options.excludeDomains,
    }
    // Tavily accepts the key in the body as well as in the header; send it in both places when
    // the caller did not pin a style, because relays in the wild implement either one.
    if (nonEmpty(apiKey) && (bodyAuth || options.authStyle === 'auto')) body.api_key = apiKey
    return body
  }
  if (options.protocol === 'openai-responses') {
    const body = {
      model: options.model,
      input: request.query,
      tools: [{ type: options.responsesToolType }],
    }
    if (bodyAuth) body.api_key = apiKey
    return body
  }
  const body = {
    model: options.model,
    messages: [{ role: 'user', content: request.query }],
  }
  if (options.chatWebSearchOptions) body.web_search_options = {}
  if (bodyAuth) body.api_key = apiKey
  return body
}

/** Map a provider payload to the seam's normalized search result. */
function mapResponse(protocol, payload) {
  if (protocol === 'tavily') return mapTavily(payload)
  if (protocol === 'openai-responses') return mapResponses(payload)
  return mapChat(payload)
}

/** Collect sources, dropping duplicates by URL and any entry without one. */
function collector() {
  const seen = new Set()
  const sources = []
  return {
    sources,
    /**
     * @param url - candidate URL.
     * @param title - candidate title.
     * @param snippet - candidate snippet.
     * @param publishedAt - candidate publication date.
     */
    add(url, title, snippet, publishedAt) {
      if (!nonEmpty(url)) return
      const trimmed = url.trim()
      if (seen.has(trimmed)) return
      seen.add(trimmed)
      sources.push({
        url: trimmed,
        ...nonEmpty(title) ? { title: title.trim() } : {},
        ...nonEmpty(snippet) ? { snippet: snippet.trim() } : {},
        ...nonEmpty(publishedAt) ? { publishedAt: publishedAt.trim() } : {},
      })
    },
  }
}

/** Map Tavily's own `POST /search` payload. */
function mapTavily(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  const sink = collector()
  for (const result of results) {
    if (result === null || typeof result !== 'object') continue
    const snippet = nonEmpty(result.content) ? result.content : result.raw_content
    sink.add(result.url, result.title, snippet, result.published_date ?? result.publishedDate)
  }
  const answer = typeof payload?.answer === 'string' && payload.answer.length > 0 ? payload.answer : undefined
  return {
    ...answer === undefined ? {} : { content: answer },
    sources: sink.sources,
    truncated: false,
  }
}

/**
 * Map an OpenAI-compatible Responses payload.
 *
 * The citations live on `output_text` annotations as `url_citation` entries whose
 * `start_index`/`end_index` delimit the quoted span of the answer, which is exactly the snippet
 * the model was shown. Some gateways instead attach sources to a `web_search_call` item.
 */
function mapResponses(payload) {
  const sink = collector()
  const texts = []
  const output = Array.isArray(payload?.output) ? payload.output : []
  for (const item of output) {
    if (item === null || typeof item !== 'object') continue
    if (item.type === 'web_search_call') {
      for (const source of arrayOf(item.action?.sources)) {
        if (source === null || typeof source !== 'object') continue
        sink.add(source.url, source.title, source.snippet ?? source.text, source.published_date)
      }
      continue
    }
    for (const part of arrayOf(item.content)) {
      if (part === null || typeof part !== 'object') continue
      const text = typeof part.text === 'string' ? part.text : undefined
      if (text !== undefined && text.length > 0) texts.push(text)
      for (const annotation of arrayOf(part.annotations)) {
        if (annotation === null || typeof annotation !== 'object') continue
        if (annotation.type !== 'url_citation') continue
        sink.add(annotation.url, annotation.title, spanOf(text, annotation), annotation.published_date)
      }
    }
  }
  const answer = texts.join('\n').trim()
  return {
    ...answer.length === 0 ? {} : { content: answer },
    sources: sink.sources,
    truncated: false,
  }
}

/**
 * Map an OpenAI-compatible Chat Completions payload.
 *
 * Citation annotations are preferred; when a gateway returns none, the answer's markdown links
 * are the only structured evidence of what was read, so they become the sources.
 */
function mapChat(payload) {
  const sink = collector()
  const choice = arrayOf(payload?.choices)[0]
  const message = choice !== undefined && typeof choice === 'object' ? choice.message : undefined
  const text = typeof message?.content === 'string' ? message.content : undefined
  for (const annotation of arrayOf(message?.annotations)) {
    if (annotation === null || typeof annotation !== 'object') continue
    if (annotation.type !== 'url_citation') continue
    sink.add(annotation.url, annotation.title, spanOf(text, annotation), annotation.published_date)
  }
  if (sink.sources.length === 0 && text !== undefined) {
    for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/gu)) {
      sink.add(match[2], match[1])
    }
  }
  return {
    ...text === undefined || text.trim().length === 0 ? {} : { content: text },
    sources: sink.sources,
    truncated: false,
  }
}

/** Read a citation's quoted span out of the answer text it annotates. */
function spanOf(text, annotation) {
  if (typeof text !== 'string') return undefined
  const start = Number.isInteger(annotation.start_index) ? annotation.start_index : undefined
  const end = Number.isInteger(annotation.end_index) ? annotation.end_index : undefined
  if (start === undefined || end === undefined || end <= start || start < 0 || end > text.length) return undefined
  return text.slice(start, end)
}

/** Coerce a possibly-absent value into an array. */
function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Project one settings revision into the options the provider serves its next search with.
 *
 * Environment fallbacks live here rather than in the provider: every value the provider reads is
 * already fully defaulted and normalized.
 *
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative settings section.
 * @returns the options for one search.
 */
function resolveOptions(ctx, config) {
  const rawProtocol = read(config.protocol, 'tavily')
  const protocol = normalizeProtocol(rawProtocol)
  const baseURL = read(config.baseURL, '')
  const endpoint = resolveEndpoint(protocol ?? 'tavily', baseURL)
  const apiKeyEnv = nonEmpty(read(config.apiKeyEnv, DEFAULT_API_KEY_ENV))
    ? read(config.apiKeyEnv, DEFAULT_API_KEY_ENV).trim()
    : DEFAULT_API_KEY_ENV
  const authStyle = normalizeAuthStyle(read(config.authStyle, 'auto'))
  const literalApiKey = read(config.apiKey, '')
  const defaultParameters = parseDefaultParameters(read(config.defaultParameters, undefined))
  return {
    rawProtocol,
    protocol,
    endpoint,
    apiKeyEnv,
    authStyle,
    authHeader: read(config.authHeader, ''),
    authScheme: read(config.authScheme, 'Bearer'),
    apiKey: literalApiKey,
    // Tavily's own host serves a keyless tier, and an endpoint the user explicitly marked as
    // unauthenticated must not fail before dispatch.
    optionalCredential: protocol === 'tavily' && endpoint.startsWith(TAVILY_OFFICIAL_ORIGIN) || authStyle === 'none',
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const resolved = await credentials.resolve(apiKeyEnv)
        if (nonEmpty(resolved?.value)) return resolved.value
      }
      const environment = ctx.get('launchEnvironment')
      const ambient = environment !== undefined
        ? environment.get(apiKeyEnv)?.value
        : process.env[process.platform === 'win32' ? apiKeyEnv.toUpperCase() : apiKeyEnv]
      return nonEmpty(ambient) ? ambient : undefined
    },
    model: read(config.model, '') || defaultModel(protocol),
    searchDepth: nonEmpty(read(config.searchDepth, 'basic')) ? read(config.searchDepth, 'basic').trim() : 'basic',
    topic: nonEmpty(read(config.topic, 'general')) ? read(config.topic, 'general').trim() : 'general',
    maxResults: positiveInteger(read(config.maxResults, 5), 5),
    includeAnswer: asBoolean(read(config.includeAnswer, 'false')),
    includeRawContent: asBoolean(read(config.includeRawContent, false)),
    includeDomains: arrayOf(read(config.includeDomains, [])),
    excludeDomains: arrayOf(read(config.excludeDomains, [])),
    defaultParameters: defaultParameters.fields,
    defaultParametersError: defaultParameters.error,
    responsesToolType: nonEmpty(read(config.responsesToolType, 'web_search'))
      ? read(config.responsesToolType, 'web_search').trim()
      : 'web_search',
    chatWebSearchOptions: asBoolean(read(config.chatWebSearchOptions, true), true),
    timeoutMs: positiveInteger(read(config.timeoutMs, 30000), 30000),
    extraHeaders: plainHeaders(read(config.extraHeaders, {})),
  }
}

/**
 * Read the `defaultParameters` blob into request-body fields.
 *
 * This is the plugin's counterpart to the official Tavily MCP's `DEFAULT_PARAMETERS`: instead of a
 * schema field per Tavily parameter, one object carries them all — `time_range`, `country`,
 * `exact_match`, `chunks_per_source`, and whatever Tavily adds next.
 *
 * A settings form's text control always stages a string, while a profile's YAML can write the
 * object directly, so both shapes resolve to the same fields. A malformed value is reported rather
 * than thrown here, because the seam calls option resolution from `available()`, which must not
 * throw during provider selection.
 *
 * @param value - the configured JSON string, object, or undefined.
 * @returns the fields to merge, and why they could not be read when they could not.
 */
function parseDefaultParameters(value) {
  if (value === undefined || value === null) return { fields: {} }
  if (typeof value === 'object' && !Array.isArray(value)) return { fields: { ...value } }
  if (typeof value !== 'string' || value.trim().length === 0) return { fields: {} }
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    return { fields: {}, error: `defaultParameters is not valid JSON (${String(error)})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { fields: {}, error: 'defaultParameters must be a JSON object, for example {"time_range":"week"}' }
  }
  return { fields: { ...parsed } }
}

/** Normalize an auth style, falling back to `auto`. */
function normalizeAuthStyle(value) {
  if (!nonEmpty(value)) return 'auto'
  const normalized = value.trim().toLowerCase()
  return AUTH_STYLES.includes(normalized) ? normalized : 'auto'
}

/** Default model per protocol; the Tavily protocol ignores it. */
function defaultModel(protocol) {
  return protocol === 'openai-chat' ? 'gpt-4o-search-preview' : 'gpt-4o'
}

/** Coerce a value into a positive integer. */
function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** Keep only string-valued header entries. */
function plainHeaders(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const headers = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[key] = entry
  }
  return headers
}

/**
 * Register the Tavily-compatible search provider with `ctx.web`.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config, volatile fields as live references.
 */
export function apply(ctx, config) {
  const providerId = nonEmpty(read(config?.providerId, '')) ? read(config.providerId, '').trim() : 'tavily'
  ctx.web.registerSearchProvider(new TavilySearchProvider(
    providerId,
    () => resolveOptions(ctx, config ?? {}),
  ))
}

export {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  ENDPOINT_SUFFIX,
  PROTOCOLS,
  TAVILY_OFFICIAL_ORIGIN,
  USER_AGENT,
  buildBody,
  buildHeaders,
  mapChat,
  mapResponses,
  mapTavily,
  parseDefaultParameters,
  resolveEndpoint,
  resolveOptions,
}
