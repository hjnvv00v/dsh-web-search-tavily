/**
 * Local smoke test for the browser half.
 *
 * Loads the client bundle through a stubbed `window.__ModuleLoader__`, renders the configuration
 * card with stubbed primitives, and asserts the slot registrations the Plugins page looks for.
 * This catches the failures that would otherwise only show up as a blank card in the browser:
 * a missing primitive export, a wrong prop name, a wrong slot key, or a render-time throw.
 *
 * Run with: node test/client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
// Stubs
// ---------------------------------------------------------------------------

/** Minimal element factory matching react/jsx-runtime's calling convention. */
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }

/** Names the client bundle is allowed to require. */
const primitiveExports = [
  'SettingsForm', 'SettingsFormModel', 'SettingsSecretField', 'SettingsValueField',
  'SegmentedControl', 'settingsNumberField', 'settingsTextField',
]

/** A stand-in for the shared form model, faithful enough to drive the card. */
class FakeSettingsFormModel {
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.secrets = new Map(secrets.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.listeners = new Set()
    this.writes = []
  }

  bind(project) {
    this.project = project
    this.snapshot = project()
    const store = {
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      set: (value) => {
        this.snapshot = value
        for (const listener of this.listeners) listener()
      },
    }
    this.store = store
    return store
  }

  shell() {
    return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
  }

  field(field) {
    const staged = this.staged.get(field)
    const value = this.scope.getSnapshot().value?.[field]
    return { text: staged ?? (typeof value === 'string' ? value : ''), overridden: false, invalid: false }
  }

  actions() {
    return {
      edit: (field, text) => {
        this.staged.set(field, text)
        this.publish()
      },
      resetField: (field) => {
        this.staged.delete(field)
        this.publish()
      },
      save: async () => {
        for (const [field, spec] of this.secrets) {
          const text = this.staged.get(field)
          if (text === undefined || text === '') continue
          this.writes.push({ field, ok: await spec.write(text) })
        }
      },
      discard: () => {
        this.staged.clear()
        this.publish()
      },
    }
  }

  /** Re-project into the bound store, the way the shared model republishes on every stage. */
  publish() {
    if (this.store !== undefined && this.project !== undefined) this.store.set(this.project())
  }

  dispose() {}
}

const primitives = {
  SettingsForm: function SettingsForm(props) {
    return jsx('div', { 'data-testid': 'settings-form', children: props.children })
  },
  SettingsFormModel: FakeSettingsFormModel,
  SettingsSecretField: function SettingsSecretField(props) {
    return jsx('div', { 'data-testid': `secret-${props.id}`, children: props.label })
  },
  SettingsValueField: function SettingsValueField(props) {
    return jsx('div', { 'data-testid': `value-${props.id}`, children: props.label })
  },
  SegmentedControl: function SegmentedControl(props) {
    return jsx('div', {
      'data-testid': `choice-${props.id}`,
      'data-value': String(props.value),
      'data-options': props.options.map((option) => option.value).join(','),
      children: props.label,
    })
  },
  settingsTextField: (field) => ({ field, format: (value) => (typeof value === 'string' ? value : ''), parse: (text) => ({ kind: 'set', value: text }) }),
  settingsNumberField: (field) => ({ field, format: (value) => (typeof value === 'number' ? String(value) : ''), parse: (text) => ({ kind: 'set', value: Number(text) }) }),
}

const requireStub = (name) => {
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
}

// ---------------------------------------------------------------------------
// Load the bundle the way the client module system does
// ---------------------------------------------------------------------------

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
await import(`file://${clientPath.replaceAll('\\', '/')}`)

console.log('\nbundle')

await check('the bundle declares the package id the module system attaches it by', () => {
  assert.ok(loaded !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-web-search-tavily-relay')
  assert.equal(typeof loaded.factory, 'function')
})

const clientModule = loaded.factory(requireStub)

await check('the browser half exports apply and inject', () => {
  assert.equal(typeof clientModule.apply, 'function')
  assert.deepEqual([...clientModule.inject].sort(), ['configForms', 'locale', 'remote', 'remote.credentials', 'slots'])
})

// ---------------------------------------------------------------------------
// Mount it against a fake page context
// ---------------------------------------------------------------------------

const registered = []
const scopeSnapshot = {
  status: 'ready',
  writable: true,
  revision: 1,
  value: { protocol: 'tavily', baseURL: 'https://relay.example', apiKeyEnv: 'TAVILY_KEY' },
}
const scope = {
  getSnapshot: () => scopeSnapshot,
  subscribe: () => () => {},
}
const credentialCalls = []

const ctx = {
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  effect: (run) => {
    const disposer = run()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  configForms: {
    get: () => scope,
    whileServed: (namespaces, register) => register(new Set(namespaces)),
  },
  slots: {
    inject: (name, register) => register(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
  remote: {
    $on: () => () => {},
    credentials: {
      describe: async (refs) => {
        credentialCalls.push({ kind: 'describe', refs })
        return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: true, writable: true }])) }
      },
      set: async (ref, value) => {
        credentialCalls.push({ kind: 'set', ref, value })
      },
    },
  },
}

clientModule.apply(ctx)

await check('the card registers into both the bundle page and the row page', () => {
  const byName = Object.fromEntries(registered.map((entry) => [entry.options.name, entry]))
  assert.deepEqual(Object.keys(byName).sort(), ['plugins.bundle.config', 'plugins.row.config'])
  assert.equal(byName['plugins.bundle.config'].options.key, 'dsh-web-search-tavily-relay')
  assert.equal(byName['plugins.row.config'].options.key, 'dsh-web-search-tavily-relay#web-search-tavily')
  for (const entry of registered) {
    assert.equal(entry.options.locale, 'webSearchTavily')
    assert.equal(typeof entry.component, 'function')
    assert.equal(typeof entry.options.inject, 'function')
  }
})

// ---------------------------------------------------------------------------
// Render the card
// ---------------------------------------------------------------------------

/** Walk a stubbed element tree, invoking function components, and collect every test id. */
function collect(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, found)
    return found
  }
  if (typeof node === 'string' || typeof node === 'number') return found
  if (typeof node.type === 'function') {
    collect(node.type(node.props), found)
    return found
  }
  if (typeof node.type === 'string') {
    const id = node.props['data-testid']
    if (id !== undefined) found.push({ id, value: node.props['data-value'], options: node.props['data-options'] })
    collect(node.props.children, found)
  }
  return found
}

const injection = registered[0].options.inject()
const store = injection.hooks.tavilySearchCard

await check('the injection exposes the hook and the form actions the card calls', () => {
  assert.ok(store !== undefined, 'hooks.tavilySearchCard must be the store the card reads')
  assert.equal(typeof store.getSnapshot, 'function')
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof injection[action], 'function', `the card needs props.${action}`)
  }
})

await check('the summary view is a one-liner with no controls', () => {
  const tree = registered[0].component({ t: (key) => key, view: 'summary', useTavilySearchCard: (select) => select(store.getSnapshot()) })
  assert.equal(tree, 'description')
})

await check('the page view renders every control without throwing', () => {
  const tree = registered[0].component({
    t: (key) => key,
    view: 'page',
    useTavilySearchCard: (select) => select(store.getSnapshot()),
    ...injection,
  })
  const found = collect(tree)
  const ids = found.map((entry) => entry.id)
  assert.ok(ids.includes('settings-form'), 'the form frame must render')
  for (const field of ['protocol', 'baseURL', 'model', 'authStyle', 'authHeader', 'authScheme', 'apiKeyEnv', 'searchDepth', 'topic', 'maxResults', 'includeAnswer', 'timeoutMs', 'defaultParameters']) {
    assert.ok(
      ids.includes(`value-plugin-config-tavily-${field}`) || ids.includes(`choice-plugin-config-tavily-${field}`),
      `${field} must render a control`,
    )
  }
  assert.ok(ids.includes('secret-plugin-config-tavily-key'), 'the API key must render its write-only control')
})

await check('the segmented choices carry the right values and option sets', () => {
  const tree = registered[0].component({
    t: (key) => key,
    view: 'page',
    useTavilySearchCard: (select) => select(store.getSnapshot()),
    ...injection,
  })
  const found = Object.fromEntries(collect(tree).map((entry) => [entry.id, entry]))
  assert.equal(found['choice-plugin-config-tavily-protocol'].value, 'tavily')
  assert.equal(found['choice-plugin-config-tavily-protocol'].options, 'tavily,openai-responses,openai-chat')
  assert.equal(found['choice-plugin-config-tavily-authStyle'].options, 'auto,bearer,body,header,none')
  assert.equal(found['choice-plugin-config-tavily-includeAnswer'].options, 'false,true')
})

await check('a staged protocol edit flows through the shared form', async () => {
  const tree = registered[0].component({
    t: (key) => key,
    view: 'page',
    useTavilySearchCard: (select) => select(store.getSnapshot()),
    ...injection,
  })
  // The card wires each control's onEdit to props.edit(field, value); exercise it directly.
  injection.edit('protocol', 'openai-chat')
  assert.equal(store.getSnapshot().protocol.text, 'openai-chat')
  assert.ok(tree !== undefined)
})

await check('saving the form writes the staged key through the credentials domain', async () => {
  injection.edit('apiKey', 'tvly-staged-key')
  await injection.save()
  const write = credentialCalls.find((call) => call.kind === 'set')
  assert.ok(write !== undefined, 'a staged key must be written through remote.credentials.set')
  assert.equal(write.value, 'tvly-staged-key')
  assert.equal(write.ref, 'TAVILY_KEY', 'the write must address the reference the section names')
  const describe = credentialCalls.find((call) => call.kind === 'describe')
  assert.ok(describe !== undefined)
  assert.deepEqual(describe.refs, ['TAVILY_KEY'])
})

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed\n`)
process.exitCode = failures === 0 ? 0 : 1
