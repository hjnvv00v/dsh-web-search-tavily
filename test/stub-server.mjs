/**
 * A stand-in "relay": answers Tavily's `POST /search` shape on a local port.
 *
 * Used to prove the whole chain — `web_search` tool → `ctx.web` → this provider → a custom
 * baseURL — without needing a real relay account.
 *
 *   node test/stub-server.mjs 8791
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 8791)

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const reply = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    console.log(`[stub] ${request.method} ${request.url} auth=${request.headers.authorization ?? 'none'} body=${body.slice(0, 200)}`)
    if (!request.url.startsWith('/search')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ detail: 'not found' }))
      return
    }
    let query = 'unknown'
    try { query = JSON.parse(body).query ?? query } catch { /* keep the default */ }
    reply({
      answer: `Stub relay answered "${query}" — the request reached a custom domain.`,
      results: [
        {
          title: 'Relay proof — result one',
          url: 'https://relay-proof.example/one',
          content: 'This source came from the local stub, not from api.tavily.com.',
          published_date: '2026-10-08',
        },
        {
          title: 'Relay proof — result two',
          url: 'https://relay-proof.example/two',
          content: 'A second source, so the mapping and dedupe are exercised too.',
        },
      ],
    })
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[stub] Tavily-shaped relay listening on http://127.0.0.1:${port}`)
})
