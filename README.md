# dsh-web-search-tavily

Tavily-backed web search for the DeepSeek Harness web seam (`ctx.web`) — with the endpoint,
credential, and wire protocol all configurable, so a **relay or gateway domain works exactly like
the official one**.

Registering into `ctx.web` means the harness's built-in `web_search` tool uses this provider
directly. There is no extra tool to learn and no MCP process in the middle.

## Why not the official Tavily MCP server?

Tavily does ship one ([`tavily-mcp`](https://www.npmjs.com/package/tavily-mcp)), and DSH can
consume it through `dsh-mcp-client`. It does not fit a relay deployment:

- Its endpoints are hardcoded to `https://api.tavily.com/{search,extract,crawl,map,research,feedback}`
  with no base-URL setting, so a custom domain cannot be used.
- Its tools bypass the `ctx.web` seam, so the built-in `web_search` keeps using whatever provider
  the seam selected, and the model has to choose between two parallel tool sets.

This plugin is the seam-native route: one provider, three wire protocols, one configurable endpoint.

## Protocols

| `protocol` | Request | Use it for |
|---|---|---|
| `tavily` (default) | `POST {base}/search` with Tavily's own body | Tavily itself, and relays that mirror its REST shape |
| `openai-responses` | `POST {base}/responses` with the native `web_search` tool | OpenAI-compatible gateways that expose the Responses API |
| `openai-chat` | `POST {base}/chat/completions` with `web_search_options` | OpenAI-compatible gateways whose models search and cite |

Aliases are accepted (`responses`, `chat`, `rest`, …), and the endpoint may be either a base
(`https://relay.example/v1` → `…/v1/search`) or a complete URL.

Sources are read from structured evidence only: Tavily's `results[]`, a Responses payload's
`url_citation` annotations and `web_search_call` sources, or a Chat payload's annotations — falling
back to the answer's markdown links when a gateway returns no annotations at all.

## Configuration

Everything below is editable on the plugin's page under **Plugins** in the Web sidebar, or written
into the profile's `cordis.patch.yml`.

| Field | Default | Meaning |
|---|---|---|
| `providerId` | `tavily` | Registry id; must match the `web` entry's `searchProvider` |
| `protocol` | `tavily` | `tavily`, `openai-responses`, or `openai-chat` |
| `baseURL` | protocol default | Relay domain or full endpoint; empty uses `https://api.tavily.com` or `https://api.openai.com/v1` |
| `apiKey` | omitted | Literal key; prefer `apiKeyEnv` so no secret enters the settings file |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved through `ctx.credentials`, then the launch environment |
| `authStyle` | `auto` | `auto`, `bearer`, `body`, `header`, or `none` |
| `authHeader` | omitted | Header name for `authStyle: header` |
| `authScheme` | `Bearer` | Prefix before the key; empty sends the key bare |
| `model` | `gpt-4o-search-preview` / `gpt-4o` | Model name for the OpenAI-compatible protocols |
| `searchDepth` | `basic` | Tavily `search_depth` |
| `topic` | `general` | Tavily `topic` |
| `maxResults` | `5` | Upper bound requested from the provider |
| `includeAnswer` | `"false"` | Ask Tavily for a synthesized answer, surfaced as the result's `content` (the paragraph above the source list) |
| `includeRawContent` | `false` | Ask Tavily for `raw_content` as well; the seam's source shape has no slot for full page text, so it only backs a missing snippet — use `web_fetch` for a whole page |
| `includeDomains` / `excludeDomains` | `[]` | Tavily domain filters |
| `responsesToolType` | `web_search` | Some gateways need `web_search_preview` |
| `chatWebSearchOptions` | `true` | Send `web_search_options` on Chat Completions requests |
| `timeoutMs` | `30000` | Per-request timeout |
| `defaultParameters` | omitted | Catch-all request fields, merged last — the counterpart to the official MCP's `DEFAULT_PARAMETERS` |
| `extraHeaders` | `{}` | Extra headers, merged last |

### Catch-all parameters

Tavily's official MCP configures search behaviour with one `DEFAULT_PARAMETERS` environment
variable (or request header) holding a JSON object that overrides any parameter of the
`tavily_search` tool. This plugin takes the same object as `defaultParameters`, so a parameter
Tavily adds later needs no plugin change:

```yaml
- id: web-search-tavily
  name: dsh-web-search-tavily
  config:
    baseURL: https://relay.example
    defaultParameters:
      time_range: week
      country: China
      exact_match: true
```

A settings form stages a string, so the card writes the same value as JSON text
(`{"time_range":"week"}`); a profile's YAML may write the object directly. Both resolve to the
same fields.

It merges into the request body **last**, which is how the MCP applies its defaults over the
tool's own arguments — so it also overrides the modelled fields above. The one field it cannot
replace is `query`: a search whose subject came from configuration rather than from the model
would be a silent, confusing failure.

**One deliberate difference from the MCP.** The MCP's merge loop walks the parameters it already
sends (`for (const key in searchParams) if (key in defaults) …`), so `DEFAULT_PARAMETERS` can only
*override* a value — it cannot introduce a key the server never sends. That makes
`include_answer` and `chunks_per_source` unreachable through the official MCP by any means. This
plugin's loop walks the configured object instead, so it can *add* fields as well as override
them.

| Official MCP `tavily_search` parameter | This plugin |
|---|---|
| `query` | the caller's query — never overridable |
| `search_depth` | `searchDepth` |
| `topic` | `topic` |
| `max_results` | `maxResults` |
| `include_raw_content` | `includeRawContent` |
| `include_domains` / `exclude_domains` | `includeDomains` / `excludeDomains` |
| `time_range`, `start_date`, `end_date`, `country`, `exact_match`, `include_images`, `include_image_descriptions`, `include_favicon` | `defaultParameters` |
| — not reachable through the MCP at all | `includeAnswer`, `chunks_per_source`, and any other parameter Tavily accepts |

### Authentication

`authStyle: auto` sends `Authorization: Bearer <key>` and, for the `tavily` protocol, also
`api_key` in the body — relays in the wild implement one or the other. Pick `bearer`, `body`, or
`header` when a relay is strict, and `none` for an endpoint that needs no credential.

The key resolves in this order: a literal `apiKey`, then `ctx.credentials` under `apiKeyEnv`, then
the environment DSH was launched from. A key written on the configuration page goes through the
credentials domain, so it never lands in the settings document.

Without any key, a request to `https://api.tavily.com` is sent in Tavily's keyless mode.

## Install

```sh
# From this package's directory:
node install.mjs                 # copies into the desktop profile and wires the seam
node install.mjs --profile web   # or any other profile
```

The installer copies the package into `<profile>/node_modules`, adds it to the profile's
`dsh.profile.bundles`, and points the `web` entry's `searchProvider` at it. It is idempotent, keeps
a `.bak` of every file it edits, and `node install.mjs --uninstall` reverses all of it.

After installing, reload the Web UI. If the profile has no HMR, restart DSH.

## Selecting the provider

`ctx.web` refuses to guess when more than one provider is usable, so the installer pins it:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily
```

Change `tavily` to match `providerId` if you renamed it.

## Failures

Errors carry the seam's machine-routable codes: `WEB_PROVIDER_CREDENTIAL_MISSING` for an absent
key, `WEB_ABORTED` for caller cancellation, and `WEB_PROVIDER_ERROR` for everything else — a
timeout, a non-2xx response, or an unreadable body. Every post-dispatch failure names the resolved
endpoint, and an HTTP 401/403 message points at the `authStyle` and key settings rather than
leaving the model to guess.

## Tests

```sh
npm install            # the schema checks need the @deepseek-ai/schemastery peer
node test/smoke.mjs    # host half: protocols, auth, errors, and the Host's schema projection
node test/client.mjs   # browser half: bundle contract, slot registration, and a rendered card
```

Nothing in the tests reaches the network: `test/smoke.mjs` spins up its own stub endpoint on
`127.0.0.1`. `@deepseek-ai/schemastery` is an **optional** peer — at runtime the Host supplies its
own copy, so the plugin loads with or without it — and is listed under `devDependencies` purely so
that `npm install` fetches a copy for these checks. Run without it, the schema-dependent checks
report `skip` rather than failing.

`test/smoke.mjs` deliberately round-trips the Config schema through the **host's own** copy of
`@deepseek-ai/schemastery`: a plugin resolves the peers the Host supplies, and the settings
projection is the one contract that crosses that boundary. That check needs to know where the
running host keeps its copy, so it is skipped unless you point at one:

```sh
DSH_HOST_SCHEMASTERY='file:///C:/path/to/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs' \
  node test/smoke.mjs
```

## License

[MIT](LICENSE)
