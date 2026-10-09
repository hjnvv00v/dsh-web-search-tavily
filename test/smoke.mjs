/**
 * Local smoke test for the host half.
 *
 * Runs the provider against a stub HTTP endpoint for each protocol, exercises endpoint and auth
 * resolution, and pre-flights the one cross-build contract that matters: the Host projects this
 * plugin's Config through its OWN schemastery, so the schema built here must survive
 * `toJSON()` → `new HostZ(...)` and still resolve a projected section.
 *
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync } from 'node:fs'

const {
  Config, TavilySearchProvider, apply, resolveEndpoint, resolveOptions, parseDefaultParameters,
  mapTavily, mapResponses, mapChat, buildHeaders, buildBody,
} = await import('../lib/index.js')

/**
 * The schemastery copy the *running host* uses. A plugin resolves the peers the Host supplies,
 * which can be a different build from the one this package links against — point this at the
 * host's own copy to prove the schema survives that boundary. Unset, the check is skipped.
 *
 *   DSH_HOST_SCHEMASTERY='file:///C:/path/to/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs' node test/smoke.mjs
 */
const HOST_SCHEMASTERY = process.env.DSH_HOST_SCHEMASTERY ?? ''

let failures = 0
let passes = 0

/** Run one named check, reporting rather than throwing so the whole suite always runs. */
async function check(label, run) {
  try {
    await run()
    passes += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Stub endpoint
// ---------------------------------------------------------------------------

const seen = []

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = undefined }
    seen.push({ path: request.url, headers: request.headers, body: parsed })
    const route = request.url.split('?')[0]
    const json = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    // Failure routes are matched first: every protocol endpoint ends in its own path segment,
    // so a prefix check has to win before the success branches.
    if (route.includes('/unauthorized')) return json(401, { error: { message: 'invalid api key' } })
    if (route.includes('/slow')) {
      setTimeout(() => json(200, {}), 5000)
      return
    }
    if (route.endsWith('/search')) {
      json(200, {
        answer: 'Stub answer',
        results: [
          { title: 'Alpha', url: 'https://alpha.example/a', content: 'alpha snippet', published_date: '2026-01-02' },
          { title: 'Beta', url: 'https://beta.example/b', content: 'beta snippet' },
          { title: 'Alpha again', url: 'https://alpha.example/a', content: 'duplicate' },
          { title: 'No URL', content: 'dropped' },
        ],
      })
      return
    }
    if (route.endsWith('/responses')) {
      json(200, {
        output: [
          { type: 'web_search_call', action: { sources: [{ url: 'https://call.example/c', title: 'From call' }] } },
          {
            type: 'message',
            content: [{
              type: 'output_text',
              text: 'Gamma is the answer.',
              annotations: [{ type: 'url_citation', url: 'https://gamma.example/g', title: 'Gamma', start_index: 0, end_index: 5 }],
            }],
          },
        ],
      })
      return
    }
    if (route.endsWith('/chat/completions')) {
      json(200, {
        choices: [{
          message: {
            content: 'Delta is documented at [Delta docs](https://delta.example/d).',
            annotations: [{ type: 'url_citation', url: 'https://delta.example/d', title: 'Delta', start_index: 24, end_index: 29 }],
          },
        }],
      })
      return
    }
    return json(404, { detail: 'no such route' })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/**
 * Build the options the plugin would serve one search with.
 * @param overrides - config fields to replace.
 * @param credential - what the credential store answers with.
 */
function optionsFor(overrides = {}, credential = { value: 'tvly-from-store' }) {
  const config = {
    protocol: 'tavily',
    baseURL: origin,
    apiKey: '',
    apiKeyEnv: 'TAVILY_API_KEY',
    authStyle: 'auto',
    authScheme: 'Bearer',
    model: 'gpt-4o-search-preview',
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 5,
    includeAnswer: 'true',
    timeoutMs: 30000,
    ...overrides,
  }
  const ctx = {
    get: (key) => (key === 'credentials' ? { resolve: async () => credential } : undefined),
  }
  return resolveOptions(ctx, config)
}

/** Build a provider wired to a fresh context, exactly as `apply` does. */
function providerFor(overrides = {}, credentialValue = 'tvly-from-store') {
  let registered
  apply({
    get: (key) => (key === 'credentials'
      ? { resolve: async () => (credentialValue === null ? undefined : { value: credentialValue }) }
      : undefined),
    web: { registerSearchProvider: (provider) => { registered = provider } },
  }, {
    protocol: 'tavily',
    baseURL: origin,
    apiKeyEnv: 'TAVILY_API_KEY',
    maxResults: 5,
    timeoutMs: 30000,
    ...overrides,
  })
  return registered
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

console.log('\nmapping')

await check('mapTavily dedupes by URL, drops URL-less entries, and keeps the answer', () => {
  const result = mapTavily({
    answer: 'A',
    results: [
      { title: 'One', url: 'https://one.example', content: 's1', published_date: '2026-02-03' },
      { title: 'One dup', url: 'https://one.example', content: 's2' },
      { title: 'No url', content: 's3' },
    ],
  })
  assert.equal(result.content, 'A')
  assert.equal(result.sources.length, 1)
  assert.deepEqual(result.sources[0], {
    url: 'https://one.example', title: 'One', snippet: 's1', publishedAt: '2026-02-03',
  })
  assert.equal(result.truncated, false)
})

await check('mapResponses joins annotations to their quoted span and reads web_search_call sources', () => {
  const result = mapResponses({
    output: [
      { type: 'web_search_call', action: { sources: [{ url: 'https://call.example', title: 'Call' }] } },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Gamma is the answer.',
          annotations: [{ type: 'url_citation', url: 'https://g.example', title: 'G', start_index: 0, end_index: 5 }],
        }],
      },
    ],
  })
  assert.equal(result.content, 'Gamma is the answer.')
  assert.deepEqual(result.sources.map((source) => source.url), ['https://call.example', 'https://g.example'])
  assert.equal(result.sources[1].snippet, 'Gamma')
})

await check('mapChat prefers annotations and falls back to markdown links', () => {
  const annotated = mapChat({
    choices: [{
      message: {
        content: 'See [D](https://d.example).',
        annotations: [{ type: 'url_citation', url: 'https://d.example', title: 'D', start_index: 4, end_index: 5 }],
      },
    }],
  })
  assert.deepEqual(annotated.sources.map((source) => source.url), ['https://d.example'])
  assert.equal(annotated.sources[0].snippet, '[')

  const bare = mapChat({ choices: [{ message: { content: 'See [D](https://d.example) and [E](https://e.example).' } }] })
  assert.deepEqual(bare.sources.map((source) => source.url), ['https://d.example', 'https://e.example'])
  assert.deepEqual(bare.sources.map((source) => source.title), ['D', 'E'])
})

// ---------------------------------------------------------------------------
// Endpoint + auth resolution
// ---------------------------------------------------------------------------

console.log('\nendpoint and auth')

await check('resolveEndpoint appends the protocol path, respects a full endpoint, and defaults', () => {
  assert.equal(resolveEndpoint('tavily', 'https://relay.example'), 'https://relay.example/search')
  assert.equal(resolveEndpoint('tavily', 'https://relay.example/v1/'), 'https://relay.example/v1/search')
  assert.equal(resolveEndpoint('tavily', 'https://relay.example/tavily/search'), 'https://relay.example/tavily/search')
  assert.equal(resolveEndpoint('openai-chat', 'https://relay.example/v1'), 'https://relay.example/v1/chat/completions')
  assert.equal(resolveEndpoint('openai-responses', ''), 'https://api.openai.com/v1/responses')
  assert.equal(resolveEndpoint('tavily', ''), 'https://api.tavily.com/search')
})

await check('authStyle auto sends the key as a bearer header', () => {
  const headers = buildHeaders(optionsFor({ authStyle: 'auto' }), 'k')
  assert.equal(headers.authorization, 'Bearer k')
  assert.equal(headers['content-type'], 'application/json')
})

await check('authStyle header uses the configured header name and a bare scheme', () => {
  const headers = buildHeaders(optionsFor({ authStyle: 'header', authHeader: 'x-api-key', authScheme: '' }), 'k')
  assert.equal(headers['x-api-key'], 'k')
  assert.equal(headers.authorization, undefined)
})

await check('extraHeaders merge last and can override the default content type', () => {
  const headers = buildHeaders(optionsFor({ extraHeaders: { 'x-tenant': 'acme', accept: 'text/event-stream' } }), 'k')
  assert.equal(headers['x-tenant'], 'acme')
  assert.equal(headers.accept, 'text/event-stream')
})

await check('a keyless call to the official host marks the keyless tier', () => {
  const headers = buildHeaders(optionsFor({ baseURL: 'https://api.tavily.com' }, undefined), undefined)
  assert.equal(headers['x-tavily-access-mode'], 'keyless')
  assert.equal(headers.authorization, undefined)
})

await check('the Tavily body carries the key under auto and body auth but never under bearer', () => {
  assert.equal(buildBody(optionsFor({ authStyle: 'auto' }), { query: 'q' }, 'k').api_key, 'k')
  assert.equal(buildBody(optionsFor({ authStyle: 'body' }), { query: 'q' }, 'k').api_key, 'k')
  assert.equal(buildBody(optionsFor({ authStyle: 'bearer' }), { query: 'q' }, 'k').api_key, undefined)
  assert.equal(buildBody(optionsFor({ authStyle: 'none' }), { query: 'q' }, undefined).api_key, undefined)
})

await check('the caller\'s maxResults narrows, never widens, the configured bound', () => {
  const options = optionsFor({ maxResults: 10 })
  assert.equal(buildBody(options, { query: 'q', maxResults: 3 }, 'k').max_results, 3)
  assert.equal(buildBody(options, { query: 'q', maxResults: 50 }, 'k').max_results, 10)
  assert.equal(buildBody(options, { query: 'q' }, 'k').max_results, 10)
})

// ---------------------------------------------------------------------------
// defaultParameters — this plugin's counterpart to the official MCP's DEFAULT_PARAMETERS
// ---------------------------------------------------------------------------

console.log('\ndefaultParameters')

await check('a JSON string and a YAML object resolve to the same fields', () => {
  const fromString = parseDefaultParameters('{"time_range":"week","country":"China"}')
  const fromObject = parseDefaultParameters({ time_range: 'week', country: 'China' })
  assert.deepEqual(fromString, { fields: { time_range: 'week', country: 'China' } })
  assert.deepEqual(fromObject, fromString)
  assert.deepEqual(parseDefaultParameters(undefined), { fields: {} })
  assert.deepEqual(parseDefaultParameters(''), { fields: {} })
  assert.deepEqual(parseDefaultParameters('   '), { fields: {} })
})

await check('a malformed blob is reported, not thrown, so provider selection still works', () => {
  const broken = parseDefaultParameters('{not json}')
  assert.deepEqual(broken.fields, {})
  assert.match(broken.error, /not valid JSON/)
  const wrongShape = parseDefaultParameters('[1,2,3]')
  assert.deepEqual(wrongShape.fields, {})
  assert.match(wrongShape.error, /must be a JSON object/)
})

await check('catch-all fields reach parameters this plugin does not model', () => {
  const options = optionsFor({ defaultParameters: '{"time_range":"week","exact_match":true,"chunks_per_source":3}' })
  const body = buildBody(options, { query: 'q' }, 'k')
  assert.equal(body.time_range, 'week')
  assert.equal(body.exact_match, true)
  assert.equal(body.chunks_per_source, 3)
})

await check('catch-all fields win over the modelled fields, as the official MCP applies its defaults', () => {
  const options = optionsFor({ searchDepth: 'basic', includeAnswer: 'false', defaultParameters: '{"search_depth":"advanced","include_answer":true}' })
  const body = buildBody(options, { query: 'q' }, 'k')
  assert.equal(body.search_depth, 'advanced')
  assert.equal(body.include_answer, true)
})

await check('the caller\'s query is never overridable', () => {
  const options = optionsFor({ defaultParameters: '{"query":"hijacked"}' })
  assert.equal(buildBody(options, { query: 'the real question' }, 'k').query, 'the real question')
})

await check('catch-all fields also apply to the OpenAI protocols', () => {
  const options = optionsFor({ protocol: 'openai-chat', baseURL: `${origin}/v1`, defaultParameters: '{"temperature":0}' })
  const body = buildBody(options, { query: 'q' }, 'k')
  assert.equal(body.temperature, 0)
  assert.equal(body.messages[0].content, 'q')
})

await check('a malformed blob fails the search with the field named', async () => {
  const provider = providerFor({ defaultParameters: '{broken' })
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /defaultParameters is not valid JSON/)
    return true
  })
})

await check('a malformed blob still leaves the provider selectable', () => {
  const provider = providerFor({ defaultParameters: '{broken' })
  assert.equal(provider.available(), true, 'available() must not throw or go false on a config typo')
})

// ---------------------------------------------------------------------------
// Live calls against the stub
// ---------------------------------------------------------------------------

console.log('\nlive calls')

await check('tavily protocol: path, store-resolved credential, body, and mapped result', async () => {
  seen.length = 0
  const provider = providerFor({ includeAnswer: 'true' })
  const result = await provider.search({ query: 'hello world', maxResults: 3 })
  assert.equal(seen[0].path, '/search')
  assert.equal(seen[0].headers.authorization, 'Bearer tvly-from-store')
  assert.equal(seen[0].body.api_key, 'tvly-from-store')
  assert.equal(seen[0].body.query, 'hello world')
  assert.equal(seen[0].body.max_results, 3)
  assert.equal(seen[0].body.include_answer, true)
  assert.equal(result.content, 'Stub answer')
  assert.deepEqual(result.sources.map((source) => source.url), ['https://alpha.example/a', 'https://beta.example/b'])
})

await check('a literal apiKey wins over the credential store', async () => {
  seen.length = 0
  const provider = providerFor({ apiKey: 'tvly-literal' })
  await provider.search({ query: 'q' })
  assert.equal(seen[0].headers.authorization, 'Bearer tvly-literal')
})

await check('openai-chat protocol: v1 base, web_search_options, annotation mapping', async () => {
  seen.length = 0
  const provider = providerFor({ protocol: 'openai-chat', baseURL: `${origin}/v1` })
  const result = await provider.search({ query: 'delta' })
  assert.equal(seen[0].path, '/v1/chat/completions')
  assert.deepEqual(seen[0].body.web_search_options, {})
  assert.equal(seen[0].body.model, 'gpt-4o-search-preview')
  assert.equal(seen[0].body.messages[0].content, 'delta')
  assert.equal(seen[0].body.api_key, undefined)
  assert.deepEqual(result.sources.map((source) => source.url), ['https://delta.example/d'])
})

await check('openai-responses protocol: native web_search tool and both source shapes', async () => {
  seen.length = 0
  const provider = providerFor({ protocol: 'openai-responses', baseURL: `${origin}/v1` })
  const result = await provider.search({ query: 'gamma' })
  assert.equal(seen[0].path, '/v1/responses')
  assert.deepEqual(seen[0].body.tools, [{ type: 'web_search' }])
  assert.equal(seen[0].body.input, 'gamma')
  assert.deepEqual(result.sources.map((source) => source.url), ['https://call.example/c', 'https://gamma.example/g'])
})

await check('a relay that needs web_search_preview gets it from responsesToolType', async () => {
  seen.length = 0
  const provider = providerFor({ protocol: 'openai-responses', baseURL: `${origin}/v1`, responsesToolType: 'web_search_preview' })
  await provider.search({ query: 'gamma' })
  assert.deepEqual(seen[0].body.tools, [{ type: 'web_search_preview' }])
})

await check('authStyle none sends no credential and needs no key', async () => {
  seen.length = 0
  const provider = providerFor({ authStyle: 'none' }, null)
  assert.equal(provider.available(), true)
  await provider.search({ query: 'x' })
  assert.equal(seen[0].headers.authorization, undefined)
  assert.equal(seen[0].body.api_key, undefined)
})

await check('protocol aliases resolve to the same wire shape', async () => {
  seen.length = 0
  const provider = providerFor({ protocol: 'chat-completions', baseURL: `${origin}/v1` })
  await provider.search({ query: 'x' })
  assert.equal(seen[0].path, '/v1/chat/completions')
})

await check('a 401 names the endpoint and points at the configuration page', async () => {
  const provider = providerFor({ baseURL: `${origin}/unauthorized` })
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /HTTP 401/)
    assert.match(error.message, /invalid api key/)
    assert.match(error.message, /authStyle/)
    return true
  })
})

await check('a missing credential fails as WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
  const provider = providerFor({ protocol: 'openai-chat', baseURL: `${origin}/v1`, apiKeyEnv: 'MISSING_KEY_XYZ' }, null)
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    assert.match(error.message, /MISSING_KEY_XYZ/)
    return true
  })
})

await check('timeoutMs bounds the request and reports a timeout', async () => {
  const provider = providerFor({ baseURL: `${origin}/slow`, timeoutMs: 150 })
  const started = Date.now()
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /timed out after 150ms/)
    return true
  })
  assert.ok(Date.now() - started < 3000, 'a timeout must not wait for the slow endpoint')
})

await check('caller cancellation surfaces as WEB_ABORTED', async () => {
  const provider = providerFor({ baseURL: `${origin}/slow`, timeoutMs: 30000 })
  const controller = new AbortController()
  const pending = provider.search({ query: 'x' }, controller.signal)
  controller.abort()
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'WEB_ABORTED')
    return true
  })
})

await check('an unrecognized protocol fails loudly instead of guessing', async () => {
  const provider = providerFor({ protocol: 'grpc' })
  assert.equal(provider.available(), false)
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /does not recognize protocol/)
    return true
  })
})

// ---------------------------------------------------------------------------
// Host contract: the settings projection runs through the Host's own schemastery
// ---------------------------------------------------------------------------

console.log('\nhost contract')

// Every check below builds on the Config schema, which only exists when the peer resolves. A bare
// `git clone` has no node_modules, so the peer can legitimately be absent — skip in that case, but
// never when the peer IS present, or a broken schema would hide behind a skip.
const hasSchemastery = await import('@deepseek-ai/schemastery').then(() => true, () => false)
const NO_PEER = 'peer @deepseek-ai/schemastery is not installed — run npm install'

if (hasSchemastery) {
  await check('Config is a schema the Host can project into a settings form', async () => {
    assert.ok(Config !== undefined, 'Config must be defined — the settings page depends on it')
    assert.equal(Config.type, 'object')
    for (const field of ['protocol', 'baseURL', 'apiKey', 'apiKeyEnv', 'model', 'maxResults', 'timeoutMs', 'authStyle']) {
      assert.equal(Config.dict[field].meta.volatile, true, `${field} must be volatile to appear in a settings form`)
    }
    assert.equal(Config.dict.apiKey.meta.role, 'secret')
    assert.equal(Config.dict.apiKeyEnv.meta.role, 'credential-ref')
    assert.equal(Config.dict.providerId.meta.volatile, undefined, 'providerId stays YAML-only')
    assert.equal(Config.dict.extraHeaders.meta.volatile, undefined, 'extraHeaders stays YAML-only')
  })

  await check('the Host\'s volatileForm projection keeps exactly the editable fields', async () => {
    // Mirrors @deepseek-ai/dsh-settings: a form exists only when some field is volatile, and it
    // carries only the fields beneath a volatile node.
    const volatileForm = (schema) => {
      if (schema.meta.volatile) return schema
      if (schema.type !== 'object') return undefined
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }))
      return Object.keys(dict).length === 0 ? undefined : dict
    }
    const form = volatileForm(Config)
    assert.ok(form !== undefined, 'the Host must find at least one volatile field')
    assert.deepEqual(Object.keys(form).sort(), [
      'apiKey', 'apiKeyEnv', 'authHeader', 'authScheme', 'authStyle', 'baseURL', 'defaultParameters',
      'includeAnswer', 'maxResults', 'model', 'protocol', 'searchDepth', 'timeoutMs', 'topic',
    ])
  })
} else {
  console.log(`  skip Config is a schema the Host can project into a settings form (${NO_PEER})`)
  console.log(`  skip the Host's volatileForm projection keeps exactly the editable fields (${NO_PEER})`)
}

if (hasSchemastery && existsSync(HOST_SCHEMASTERY.replace('file:///', ''))) {
  await check('the running host\'s schemastery rehydrates this schema and resolves a section', async () => {
    const hostZ = (await import(HOST_SCHEMASTERY)).default
    const rebuilt = new hostZ(Config.toJSON())
    assert.equal(rebuilt.type, 'object', 'the ref-preserving dump must rehydrate into an object schema')
    assert.equal(rebuilt.dict.protocol.meta.volatile, true, 'volatile metadata must survive the dump')
    assert.equal(rebuilt.dict.apiKey.meta.role, 'secret')

    const resolved = rebuilt({ protocol: 'tavily', baseURL: 'https://relay.example', maxResults: 3 })
    // A volatile field resolves to a live reference, which is what the plugin reads through .get().
    assert.equal(resolved.protocol.get(), 'tavily')
    assert.equal(resolved.baseURL.get(), 'https://relay.example')
    assert.equal(resolved.maxResults.get(), 3)
    assert.equal(resolved.apiKeyEnv.get(), 'TAVILY_API_KEY', 'defaults must survive the cross-build round trip')
    assert.equal(resolved.timeoutMs.get(), 30000)
    assert.equal(resolved.providerId, 'tavily', 'an ordinary field stays a plain value')
    const rejection = rebuilt['~standard'].validate({ protocol: 'tavily', maxResults: 'three' })
    assert.ok(rejection.issues !== undefined, 'a bad section must be rejected through the standard-schema face')
  })
} else if (!hasSchemastery) {
  console.log(`  skip the host schemastery round trip (${NO_PEER})`)
} else {
  console.log('  skip the host schemastery round trip (extracted host copy not present)')
}

await check('apply registers exactly one provider under the configured id', () => {
  const registered = []
  const ctx = { get: () => undefined, web: { registerSearchProvider: (provider) => registered.push(provider) } }
  apply(ctx, { providerId: 'tavily' })
  apply(ctx, { providerId: 'my-relay' })
  assert.deepEqual(registered.map((provider) => provider.id), ['tavily', 'my-relay'])
  assert.equal(typeof registered[0].available, 'function')
  assert.equal(typeof registered[0].search, 'function')
})

await check('volatile references and plain values are both read correctly', () => {
  const ref = (value) => ({ get: () => value })
  const asRef = optionsFor({ protocol: ref('openai-chat'), baseURL: ref(`${origin}/v1`), maxResults: ref(2) })
  assert.equal(asRef.protocol, 'openai-chat')
  assert.equal(asRef.endpoint, `${origin}/v1/chat/completions`)
  assert.equal(asRef.maxResults, 2)
  const asPlain = optionsFor({ protocol: 'openai-chat', baseURL: `${origin}/v1` })
  assert.equal(asPlain.protocol, 'openai-chat')
})

await check('a missing Config schema leaves the plugin loadable', () => {
  // resolveOptions must tolerate a bare config object with no schema defaults at all.
  const options = resolveOptions({ get: () => undefined }, {})
  assert.equal(options.protocol, 'tavily')
  assert.equal(options.endpoint, 'https://api.tavily.com/search')
  assert.equal(options.maxResults, 5)
  assert.equal(options.timeoutMs, 30000)
  assert.equal(options.optionalCredential, true, 'the official host may be called without a key')
})

// ---------------------------------------------------------------------------

server.closeAllConnections?.()
server.close()
console.log(`\n${passes} passed, ${failures} failed\n`)
process.exitCode = failures === 0 ? 0 : 1
