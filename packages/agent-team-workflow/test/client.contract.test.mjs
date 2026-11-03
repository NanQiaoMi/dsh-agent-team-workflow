/**
 * Contract tests for the Web half of the live board (`client.js`).
 *
 * The client module is a browser-only, buildless Cordis client plugin: it talks
 * to `window.__ModuleLoader__` and to `require('react')`, neither of which
 * exists under Node. These tests therefore stay zero-dependency and never load
 * React for real: the module text is evaluated in a `node:vm` sandbox with a
 * fake `window.__ModuleLoader__`, the factory is executed with a tiny React
 * double, and `apply()` runs against service doubles for `locale` and `slots`.
 *
 * That gives both halves of the contract:
 *   1. static — module envelope, single-require rule, required registration
 *      literals, forbidden constructs, no hardcoded colours, dictionary parity,
 *      and the v2 peer-collaboration fields the board reads (docs/12 §5);
 *   2. behavioural — the exact `conversation.view` registration shape, the
 *      locale namespace/dictionaries, a render smoke test of the empty state,
 *      and — for the v2 collaboration panels — a full mount with a ~90-line
 *      hook runtime (state + effects + a fake fetch, still no real React) so a
 *      v1 snapshot (no `run.collaboration`), a v2 snapshot, and the docs/14
 *      member-autonomy fields are all rendered end to end without a browser.
 *
 * Run: node --test test/client.contract.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'client.js')
const EXPECTED_MODULE_ID = '@local/dsh-agent-team-workflow'
const EXPECTED_VIEW_ID = 'agent-team-workflow'
const EXPECTED_ORDER = 30
const EXPECTED_NS = 'agent-team-workflow'
const EXPECTED_SNAPSHOT_PATH = '/api/agent-team-workflow.snapshot'

const source = await readFile(CLIENT_PATH, 'utf8')

/**
 * Evaluate the module text in an isolated context with only a fake loader.
 * @returns `{ id, factory }` exactly as the loader would receive it.
 */
function captureModule(text) {
  const calls = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        calls.push(definition)
      },
    },
  }
  vm.runInNewContext(text, { window: fakeWindow }, { filename: CLIENT_PATH })
  assert.equal(calls.length, 1, 'client.js must call window.__ModuleLoader__.load exactly once')
  return calls[0]
}

/** A React double: enough surface for the factory to evaluate, none of React's behaviour. */
function createReactStub(implementation) {
  const required = []
  const react = implementation ?? {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {
      return undefined
    },
    useMemo(factory) {
      return factory()
    },
    Component: class Component {
      constructor(props) {
        this.props = props ?? {}
      }
    },
  }
  const require = (specifier) => {
    required.push(specifier)
    if (specifier !== 'react') throw new Error(`unexpected require("${specifier}")`)
    return react
  }
  return { react, require, required }
}

/**
 * Run the factory with the React double.
 * @returns `{ module, required }` where `module` is what the loader would publish.
 */
function runFactory(definition) {
  assert.equal(typeof definition.factory, 'function', 'the loader definition must carry a factory function')
  const stub = createReactStub()
  const module = definition.factory(stub.require)
  return { module, required: stub.required }
}

/**
 * Run `apply()` against locale/slot doubles.
 * @returns the captured dictionaries, entries, and effect registrations.
 */
function runApply(module) {
  const effects = []
  const localeRegistrations = []
  let boundNamespace = null
  const injections = []
  const registrations = []
  const ctx = {
    effect(run, label) {
      const disposer = run()
      effects.push({ label, disposer, localeRegistrationsBefore: localeRegistrations.length })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
      bind(namespace) {
        boundNamespace = namespace
        return (key) => 'k:' + key
      },
    },
    slots: {
      inject(slotName, factory) {
        injections.push({ slotName, factory })
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  return { effects, localeRegistrations, boundNamespace, injections, registrations }
}

/** Depth-first collect every element `className` in a stub React tree. */
function collectClassNames(node, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const child of node) collectClassNames(child, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (typeof node.props === 'object' && node.props !== null && typeof node.props.className === 'string') {
    found.push(node.props.className)
  }
  if (Array.isArray(node.children)) collectClassNames(node.children, found)
  return found
}

/** Depth-first collect every element `type` in a stub React tree. */
function collectTypes(node, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const child of node) collectTypes(child, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (node.type !== undefined) found.push(node.type)
  if (Array.isArray(node.children)) collectTypes(node.children, found)
  return found
}

/** Collect the literal keys passed to `t(...)` / `tr(...)` anywhere in the source. */
function collectLiteralCopyKeys(text) {
  const keys = new Set()
  // Trailing `,`/`)` means the argument is a complete literal; computed keys
  // (`tr('status.' + status)`) are intentionally not collected — their prefix
  // is resolved by a defensive fallback at runtime.
  const pattern = /(?:\btr|\bt)\(\s*'([A-Za-z][A-Za-z0-9_.]*)'\s*[,)]/g
  let match = pattern.exec(text)
  while (match !== null) {
    keys.add(match[1])
    match = pattern.exec(text)
  }
  return keys
}

const definition = captureModule(source)
const { module, required } = runFactory(definition)
const applied = runApply(module)

// ---------------------------------------------------------------------------
// Module envelope
// ---------------------------------------------------------------------------

test('module envelope: loader call, id, and factory', () => {
  assert.ok(
    source.trimStart().startsWith('window.__ModuleLoader__.load('),
    'client.js must start with the window.__ModuleLoader__.load( call (no leading banner)',
  )
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/)
  assert.equal(definition.id, EXPECTED_MODULE_ID, 'the module id must match package.json name')
  assert.equal(typeof definition.factory, 'function')
  assert.equal(typeof module.apply, 'function', 'the module must publish apply()')
  // Spread first: the array is created inside the vm realm, so its prototype is
  // a different `Array.prototype` than this realm's and strict deep-equality
  // would reject it on identity alone.
  assert.deepEqual([...module.inject], ['slots', 'locale'], 'the module must inject exactly the slots and locale services')
})

// ---------------------------------------------------------------------------
// Single-require rule (source and runtime)
// ---------------------------------------------------------------------------

test('only require(react) is used — statically and at factory execution', () => {
  const requires = [...source.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2])
  assert.deepEqual(requires, ['react'], 'the source may only call require(\'react\')')
  assert.deepEqual(required, ['react'], 'the factory may only resolve the react module')
  assert.ok(!source.includes('require("'), 'require must use single quotes only (the loader build assumes it)')
  assert.ok(!source.includes("require('@deepseek-ai"), 'client code must not require other Harness packages')
  assert.ok(!source.includes('import '), 'the buildless client module must not use ESM import syntax')
})

// ---------------------------------------------------------------------------
// Required registration literals (docs/09 §4)
// ---------------------------------------------------------------------------

test('registration literals: slot name, id, order, service verbs, snapshot route', () => {
  const required = [
    'conversation.view',
    "id: 'agent-team-workflow'",
    'order: 30',
    "inject: ['slots', 'locale']",
    'ctx.locale.register(',
    'ctx.locale.bind(',
    EXPECTED_SNAPSHOT_PATH,
  ]
  for (const literal of required) assert.ok(source.includes(literal), `client.js must contain ${JSON.stringify(literal)}`)
  // Polling contract that the literal check cannot see.
  for (const literal of ['credentials: \'same-origin\'', "accept: 'application/json'", 'visibilityState', 'AbortController', 'clearInterval', '1200']) {
    assert.ok(source.includes(literal), `client.js must implement the polling contract: missing ${JSON.stringify(literal)}`)
  }
  assert.ok(!source.includes('/plugin/agent-team-workflow/snapshot'), 'the pre-Connection /plugin/ route must not be polled')
})

// ---------------------------------------------------------------------------
// Forbidden constructs (docs/09 §4 视觉/边界)
// ---------------------------------------------------------------------------

test('forbidden constructs are absent', () => {
  const forbidden = ['document.body', '<iframe', 'iframe']
  for (const literal of forbidden) assert.ok(!source.includes(literal), `client.js must not reference ${JSON.stringify(literal)}`)
  assert.ok(!source.includes('Canvas'), 'the board must stay DOM/SVG based')
  assert.ok(!source.includes('dangerouslySetInnerHTML') || !source.includes('__html: source'), 'no dynamic HTML injection')
})

// ---------------------------------------------------------------------------
// No hardcoded colours: theme tokens only
// ---------------------------------------------------------------------------

test('no hardcoded hex colours (theme tokens only)', () => {
  // Allowed: no artwork colours at all. The SVG arrow marker paints itself with
  // `currentColor`, so even the artwork needs no literal colour. `url(#atw-...)`
  // marker references are ids, not colours, and the pattern below only matches
  // 3/4/6/8-digit hex literals.
  const hexColours = [...source.matchAll(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g)].map((match) => match[0])
  assert.deepEqual(hexColours, [], 'client.js must not hardcode colours; use the --dsw-alias-* tokens')
  assert.ok(!/rgba?\(/.test(source), 'client.js must not hardcode rgb()/rgba() colours')
  // Trailing alphanumeric only: prose mentions of the `--dsw-alias-*` wildcard
  // must not be mistaken for a token.
  const tokens = [...source.matchAll(/--dsw-[a-z0-9-]*[a-z0-9]/g)].map((match) => match[0])
  assert.ok(tokens.length >= 10, 'the styles must be token driven')
  const allowed = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-brand-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
  ])
  const unknown = [...new Set(tokens)].filter((token) => !allowed.has(token))
  assert.deepEqual(unknown, [], 'only the --dsw-alias-* tokens listed by docs/09 §4 may be used')
})

// ---------------------------------------------------------------------------
// Locale dictionaries
// ---------------------------------------------------------------------------

test('locale: one namespace, zh and en dictionaries with the same key set', () => {
  assert.equal(applied.localeRegistrations.length, 1, 'apply() must register exactly one locale namespace')
  const registration = applied.localeRegistrations[0]
  assert.equal(registration.namespace, EXPECTED_NS)
  assert.equal(applied.boundNamespace, EXPECTED_NS, 'the translator must be bound to the same namespace')
  assert.equal(applied.effects.length, 1, 'the locale registration must ride one ctx.effect (unloadable)')
  assert.equal(typeof applied.effects[0].disposer, 'function', 'the locale registration must return a disposer')
  assert.equal(typeof applied.effects[0].label, 'string', 'ctx.effect should be labelled for the audit trail')

  const dictionaries = registration.dictionaries
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh'], 'both zh and en dictionaries are required')
  const zh = dictionaries.zh
  const en = dictionaries.en
  assert.equal(typeof zh, 'object')
  assert.equal(typeof en, 'object')

  for (const locale of ['zh', 'en']) {
    const copy = locale === 'zh' ? zh : en
    assert.equal(typeof copy['view.label'], 'string', `${locale}.view.label must exist`)
    assert.ok(copy['view.label'].length > 0, `${locale}.view.label must not be empty`)
  }
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys, 'en must translate every zh key (no missing or stray keys)')
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.ok(zh[key].length > 0, `zh.${key} must not be empty`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.ok(en[key].length > 0, `en.${key} must not be empty`)
  }
})

test('locale: every literal t()/tr() key is translated in both dictionaries', () => {
  const zh = applied.localeRegistrations[0].dictionaries.zh
  const en = applied.localeRegistrations[0].dictionaries.en
  const used = collectLiteralCopyKeys(source)
  assert.ok(used.size > 40, `expected many literal copy keys, found ${used.size}`)
  const missing = [...used].filter((key) => !(key in zh) || !(key in en))
  assert.deepEqual(missing, [], 'visible copy must never fall back to a raw key')
  for (const key of used) assert.ok(key.includes('.') || key === 'view.label', `copy keys are namespaced short keys: ${key}`)
})

// ---------------------------------------------------------------------------
// Slot registration (behaviour, not just text)
// ---------------------------------------------------------------------------

test('conversation.view registration shape matches docs/09 §4', () => {
  assert.equal(applied.injections.length, 1, 'apply() must register one conversation.view entry')
  const injection = applied.injections[0]
  assert.equal(injection.slotName, 'conversation.view')
  assert.equal(typeof injection.factory, 'function')

  const disposer = injection.factory()
  assert.equal(typeof disposer, 'function', 'the slot registration must return its disposer')

  assert.equal(applied.registrations.length, 1)
  const { options, component } = applied.registrations[0]
  assert.equal(options.name, 'conversation.view')
  assert.equal(options.id, EXPECTED_VIEW_ID)
  assert.equal(options.order, EXPECTED_ORDER)
  assert.equal(options.locale, EXPECTED_NS)
  assert.equal(typeof options.label, 'function', 'label must be a thunk so it follows the active locale')
  assert.equal(options.label(), 'k:view.label', 'the label thunk must resolve view.label through the namespace translator')
  assert.equal(typeof options.inject, 'function', 'a per-session inject function must provide sessionId')
  // Spread the vm-realm object so the comparison crosses realms by value.
  assert.deepEqual({ ...options.inject('session-9') }, { sessionId: 'session-9' })
  assert.equal(typeof component, 'function', 'the entry must register the DashboardView component')
})

// ---------------------------------------------------------------------------
// Render smoke test: empty state, no snapshot, no DOM
// ---------------------------------------------------------------------------

test('DashboardView resets the reused conversation scrollport on mount', () => {
  // A View switch keeps the chat scroll offset in the shared scrollport; the board
  // must scroll its ancestor back to the top or it mounts out of view (live bug).
  assert.match(source, /cursor\.scrollTop = 0/, 'the board must reset the scrollport it mounts into')
  assert.match(source, /const rootRef = React\.useRef\(null\)/, 'the board needs a root ref to find its scrollport')
  assert.match(source, /ref: rootRef/, 'the root element must carry the ref')
})

test('DashboardView renders the empty state from a null snapshot without throwing', () => {
  const component = applied.registrations[0].component
  const keys = []
  const tr = (key) => {
    keys.push(key)
    return 'k:' + key
  }
  const element = component({ sessionId: 'session-1', t: tr })

  assert.equal(typeof element, 'object')
  assert.notEqual(element, null)
  assert.equal(element.type, 'div')
  assert.equal(element.props.className, 'atw-root')

  const classNames = collectClassNames(element)
  assert.ok(classNames.length > 5, `expected a rendered tree, got ${classNames.length} class name(s)`)
  assert.ok(!classNames.includes('atw-error-card'), 'the empty state must not render the error card')
  assert.ok(classNames.includes('atw-empty'), 'run=null must render the empty-state card')
  assert.ok(classNames.includes('atw-topo-canvas'), 'run=null must still render the team topology')
  assert.ok(classNames.includes('atw-header'), 'the header renders in every state')

  for (const key of ['board.title', 'empty.title', 'topology.title', 'header.refresh']) {
    assert.ok(keys.includes(key), `the rendered header must ask for ${key} through t()`)
  }
  // The stylesheet ships inside the component and is `atw-` prefixed.
  const styles = element.children.find((child) => child !== null && typeof child === 'object' && child.type === 'style')
  assert.ok(styles !== undefined, 'the component must render its own <style> element')
  assert.ok(styles.props.dangerouslySetInnerHTML.__html.includes('.atw-root'), 'the stylesheet must be `atw-` prefixed')
  assert.ok(styles.props.dangerouslySetInnerHTML.__html.includes('--dsw-alias-'), 'the stylesheet must be token driven')

  const types = collectTypes(element)
  assert.ok(types.length > 5, `expected a deep render tree, got ${types.length} node type(s)`)
  const boundary = element.children.filter((child) => child !== null && typeof child === 'object' && typeof child.type === 'function')
  assert.equal(boundary.length, 1, 'the board content must be wrapped in exactly one class error boundary')
  assert.equal(typeof boundary[0].type.prototype.componentDidCatch, 'function', 'the wrapper must be a React error boundary, not a plain wrapper')
})

// ---------------------------------------------------------------------------
// Peer collaboration v2 (docs/12 §5/§6): fields read, panels, caps, drawer
// ---------------------------------------------------------------------------

test('collaboration contract: the board reads every docs/12 §5 field', () => {
  // Snapshot block fields.
  assert.ok(source.includes('run.collaboration'), 'the board reads the run.collaboration block')
  for (const literal of ['raw.channel', 'raw.proposals', 'raw.openQueue', 'raw.pendingReviews', 'raw.handoffs', 'raw.edges', 'proposal.tally', 'proposal.votes']) {
    assert.ok(source.includes(literal), `client.js must read ${JSON.stringify(literal)}`)
  }
  // Item-level fields.
  for (const literal of ['item.assignment', 'item.claim', 'item.reviewRequests', 'item.handoffs', 'item.thread', 'item.openProposals']) {
    assert.ok(source.includes(literal), `client.js must read ${JSON.stringify(literal)}`)
  }
  assert.match(source, /const CHANNEL_LIMIT = 60/, 'the channel renders at most 60 messages')
  assert.match(source, /const PROPOSAL_LIMIT = 32/, 'the proposal panel renders at most 32 proposals')
})

test('collaboration panels use dedicated `atw-` class prefixes, styled in the component sheet', () => {
  for (const token of ['atw-channel', 'atw-proposal', 'atw-open-queue', 'atw-collab', 'atw-open-card', 'atw-edge--peer']) {
    assert.ok(source.includes(token), `client.js must use the ${token} class family`)
    assert.ok(source.includes('.' + token), `the component stylesheet must style .${token}`)
  }
})

/** Fresh ESM URL per mount so each board gets its own module scope. */
let mountImportCounter = 0

/** A stateful hook runtime: enough of React to mount the board under Node. */
function createMountRuntime() {
  const states = []
  const refs = []
  const effects = []
  let cursor = 0
  let dirty = false
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      const cell = states[index]
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
          dirty = true
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = effects[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        previous.deps.length !== deps.length ||
        previous.deps.some((value, position) => !Object.is(value, deps[position]))
      effects[index] = { fn, deps, cleanup: previous?.cleanup, run: changed }
    },
    Component: class Component {
      constructor(props) {
        this.props = props ?? {}
      }
    },
  }
  return {
    react,
    async render(component, props) {
      for (let pass = 0; pass < 40; pass += 1) {
        cursor = 0
        dirty = false
        const element = component(props)
        for (const cell of effects) {
          if (!cell || cell.run !== true) continue
          cell.run = false
          if (typeof cell.cleanup === 'function') cell.cleanup()
          const cleanup = cell.fn()
          cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
        for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) return element
      }
      throw new Error('the board never settled')
    },
  }
}

/**
 * Mount the board against a snapshot with a fake browser environment.
 * @returns `{ tree, copyKeys, keydown, render, dispose }` while the globals stay
 *   stubbed; call `dispose()` (in a `finally`) to restore them.
 */
async function mountBoard(snapshot, options = {}) {
  const runtime = createMountRuntime()
  const keydown = []
  const copyKeys = []
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const savedFetch = globalThis.fetch
  const savedSetInterval = globalThis.setInterval
  const savedClearInterval = globalThis.clearInterval
  let loaded

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      addEventListener(type, handler) {
        if (type === 'keydown') keydown.push(handler)
      },
      removeEventListener(type, handler) {
        if (type !== 'keydown') return
        const index = keydown.indexOf(handler)
        if (index !== -1) keydown.splice(index, 1)
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      __ModuleLoader__: {
        load(definition) {
          loaded = definition
        },
      },
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  })
  // Every request is recorded so tests can assert the member route contract
  // (GET member view, POST message) instead of guessing from rendered state.
  const requests = []
  const memberOption = options !== null && typeof options === 'object' ? options.member : undefined
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const method = init && typeof init.method === 'string' ? init.method : 'GET'
    const body = init && typeof init.body === 'string' ? init.body : null
    requests.push({ url: target, method, body })
    if (target.indexOf('/api/agent-team-workflow.member') !== -1) {
      const reply = typeof memberOption === 'function' ? memberOption({ url: target, method, body }) : memberOption
      if (reply === undefined || reply === null) {
        return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no member route' }) }
      }
      const status = typeof reply.status === 'number' ? reply.status : 200
      return { ok: status >= 200 && status < 300, status, json: async () => reply.body }
    }
    return { ok: true, status: 200, json: async () => snapshot }
  }
  // The board keeps a 1200ms poll; tests drive refreshes explicitly instead.
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  const restored = {
    dispose() {
      globalThis.fetch = savedFetch
      globalThis.setInterval = savedSetInterval
      globalThis.clearInterval = savedClearInterval
      for (const [name, descriptor] of [
        ['window', savedWindow],
        ['document', savedDocument],
      ]) {
        if (descriptor === undefined) delete globalThis[name]
        else Object.defineProperty(globalThis, name, descriptor)
      }
    },
  }

  // Evaluate the module in THIS realm (not the `node:vm` sandbox used by the
  // static tests) so its factory closures resolve `fetch`, `document`,
  // `setInterval` and friends against the stubs installed above.
  let component
  try {
    mountImportCounter += 1
    await import(pathToFileURL(CLIENT_PATH).href + '?mount=' + mountImportCounter)
    assert.ok(loaded !== undefined, 'the mounted module must call the module loader')
    const stub = createReactStub(runtime.react)
    const module = loaded.factory(stub.require)
    const appliedMount = runApply(module)
    // `slots.inject` is lazy: the registration only happens when the slot
    // service materializes the entry, which is what the framework does on mount.
    for (const injection of appliedMount.injections) injection.factory()
    component = appliedMount.registrations[0].component
  } catch (error) {
    // A failed mount must not leak the browser stubs into later tests.
    restored.dispose()
    throw error
  }
  // The double keeps the params in the returned string too, so assertions can
  // verify interpolated values (e.g. a `createdBy` tooltip) without a real locale.
  const t = (key, params) => {
    const rendered = params === undefined ? 'k:' + key : 'k:' + key + JSON.stringify(params)
    copyKeys.push(params === undefined ? key : key + JSON.stringify(params))
    return rendered
  }
  const render = () => runtime.render(component, { sessionId: 'session-1', t })
  return { ...restored, render, copyKeys, keydown, requests }
}

/** Depth-first collect every element matching a predicate. */
function collectElements(node, predicate, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  if (Array.isArray(node.children)) collectElements(node.children, predicate, found)
  return found
}

/** @returns the concatenated text of one stub element tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') return (node.children ?? []).map(textOf).join(' ')
  return ''
}

/** @returns every class token used anywhere in the tree. */
function classTokens(node) {
  const tokens = []
  collectElements(node, (element) => {
    if (typeof element.props?.className !== 'string') return false
    for (const token of element.props.className.split(/\s+/)) if (token !== '') tokens.push(token)
    return false
  })
  return tokens
}

/** @returns the elements carrying one exact class token. */
function findByClass(node, token) {
  return collectElements(node, (element) => typeof element.props?.className === 'string' && element.props.className.split(/\s+/).includes(token))
}

/** @returns the first button whose text contains `text`. */
function findButtonByText(node, text) {
  return collectElements(node, (element) => element.type === 'button' && textOf(element).includes(text))[0]
}

const V1_ITEM = {
  subject: 'v1 item',
  owner: 'impl-a',
  status: 'in_review',
  writeScopes: [],
  blockedBy: [],
  definitionOfDone: [],
  reviewers: ['rev-b'],
  task: null,
  report: null,
  reviews: { reworkRounds: 0, submittedRounds: 1, maxRounds: 2, pendingReviewer: 'rev-b', verdicts: [], records: [] },
  openFindings: 0,
  override: null,
}

const V1_SNAPSHOT = {
  ok: true,
  version: 1,
  generatedAt: '2026-11-02T00:00:00.000Z',
  sessionId: 'session-1',
  run: {
    id: 'run-v1',
    phase: 'reviewing',
    objective: 'v1 board',
    counts: { total: 2, approved: 0, pending: 1, inReview: 1, changesRequested: 0, escalated: 0 },
    waves: [['W1'], ['W2']],
    items: [
      { id: 'W1', wave: 1, ...V1_ITEM },
      {
        id: 'W2',
        wave: 2,
        subject: 'v1 second',
        owner: 'impl-b',
        status: 'pending',
        writeScopes: [],
        blockedBy: ['W1'],
        definitionOfDone: [],
        reviewers: [],
        task: null,
        report: null,
        reviews: { reworkRounds: 0, submittedRounds: 0, maxRounds: 2, pendingReviewer: null, verdicts: [], records: [] },
        openFindings: 0,
        override: null,
      },
    ],
    gate: null,
    escalations: [],
    events: [{ at: '2026-11-02T00:00:00.000Z', type: 'run/planned', actor: 'lead', detail: 'planned' }],
    artifacts: { root: '.agentteam', statePath: '.agentteam/state.json', reportPath: null },
  },
  team: {
    me: { name: 'lead', role: 'lead' },
    members: [
      { name: 'impl-a', role: 'teammate', status: 'running', context: 'fresh' },
      { name: 'rev-b', role: 'teammate', status: 'inactive', context: 'fresh' },
      { name: 'impl-b', role: 'teammate', status: 'running', context: 'fork' },
    ],
    tasks: [],
  },
  diagnostics: { boardSource: 'file', warnings: [] },
}

const V2_CHANNEL = [
  { id: 'm1', at: '2026-11-02T00:00:02.000Z', from: 'impl-a', to: 'rev-b', kind: 'question', text: 'F1 这个 finding 怎么修？', itemId: 'W1', findingId: 'F1' },
  { id: 'm2', at: '2026-11-02T00:00:03.000Z', from: 'rev-b', to: 'impl-a', kind: 'answer', text: '把 null 判掉', itemId: 'W1', replyTo: 'm1' },
  { id: 'm3', at: '2026-11-02T00:00:04.000Z', from: 'impl-a', to: 'team', kind: 'proposal', text: '提议改 DoD', itemId: 'W1', proposalId: 'p1' },
  { id: 'm4', at: '2026-11-02T00:00:05.000Z', from: 'impl-b', to: 'team', kind: 'objection', text: '反对', itemId: 'W1' },
  { id: 'm5', at: '2026-11-02T00:00:06.000Z', from: 'impl-a', to: 'impl-b', kind: 'handoff', text: 'W2 交给你', itemId: 'W2' },
  { id: 'm6', at: '2026-11-02T00:00:07.000Z', from: 'impl-b', to: 'impl-a', kind: 'ack', text: '收到', itemId: 'W2' },
  { id: 'm7', at: '2026-11-02T00:00:08.000Z', from: 'lead', to: 'team', kind: 'status', text: '一切正常', itemId: null },
]

const V2_SNAPSHOT = {
  ...V1_SNAPSHOT,
  version: 2,
  run: {
    ...V1_SNAPSHOT.run,
    id: 'run-v2',
    items: [
      {
        ...V1_SNAPSHOT.run.items[0],
        assignment: 'lead',
        claim: null,
        openProposals: 1,
        reviewRequests: [{ by: 'impl-a', at: '2026-11-02T00:00:09.000Z', reviewer: 'rev-b', status: 'open', respondedAt: null, response: null }],
        handoffs: [],
        thread: [V2_CHANNEL[0], V2_CHANNEL[1]],
      },
      {
        ...V1_SNAPSHOT.run.items[1],
        assignment: 'open',
        owner: '',
        claim: null,
        openProposals: 0,
        reviewRequests: [],
        handoffs: [{ by: 'impl-a', at: '2026-11-02T00:00:06.000Z', to: 'impl-b', reason: '忙不过来', status: 'offered', respondedAt: null }],
        thread: [V2_CHANNEL[4], V2_CHANNEL[5]],
      },
      {
        id: 'W3',
        wave: 2,
        subject: 'claimed item',
        owner: 'impl-b',
        status: 'running',
        writeScopes: [],
        blockedBy: [],
        definitionOfDone: [],
        reviewers: [],
        task: null,
        report: null,
        reviews: { reworkRounds: 0, submittedRounds: 0, maxRounds: 2, pendingReviewer: null, verdicts: [], records: [] },
        openFindings: 0,
        override: null,
        assignment: 'open',
        claim: { by: 'impl-b', at: '2026-11-02T00:00:10.000Z', leaseMinutes: 30, note: '我来' },
        openProposals: 0,
        reviewRequests: [],
        handoffs: [],
        thread: [],
      },
    ],
    collaboration: {
      channel: V2_CHANNEL,
      proposals: [
        {
          id: 'p1',
          at: '2026-11-02T00:00:04.000Z',
          by: 'impl-a',
          kind: 'dod',
          itemId: 'W1',
          text: 'DoD 改为两条',
          status: 'open',
          votes: [
            { by: 'rev-b', vote: 'yes', comment: '可以', at: '2026-11-02T00:00:11.000Z' },
            { by: 'impl-a', vote: 'abstain', comment: '', at: '2026-11-02T00:00:12.000Z' },
          ],
          tally: { yes: 1, no: 0, abstain: 1, affected: 2, total: 4 },
          resolvedAt: null,
          resolution: null,
        },
        {
          id: 'p2',
          at: '2026-11-02T00:00:13.000Z',
          by: 'rev-b',
          kind: 'review_policy',
          itemId: null,
          text: '评审必须附 evidence_checked',
          status: 'accepted',
          votes: [{ by: 'impl-a', vote: 'yes', comment: '', at: '2026-11-02T00:00:14.000Z' }],
          tally: { yes: 2, no: 1, abstain: 0, affected: 3, total: 4 },
          resolvedAt: '2026-11-02T00:00:15.000Z',
          resolution: 'adopt it',
        },
      ],
      openQueue: ['W2'],
      pendingReviews: [{ itemId: 'W1', requestedBy: 'impl-a', reviewer: 'rev-b', at: '2026-11-02T00:00:09.000Z' }],
      handoffs: [{ itemId: 'W2', by: 'impl-a', to: 'impl-b', reason: '忙不过来', status: 'offered', at: '2026-11-02T00:00:06.000Z' }],
      edges: [
        { from: 'impl-a', to: 'rev-b', count: 5, kinds: ['question', 'answer'] },
        { from: 'rev-b', to: 'impl-b', count: 2, kinds: ['note'] },
        { from: 'impl-a', to: 'impl-a', count: 1, kinds: [] },
      ],
    },
  },
}

test('v1 snapshot (no collaboration) renders the legacy board plus empty collaboration panels', async () => {
  const board = await mountBoard(V1_SNAPSHOT)
  try {
    const tree = await board.render()
    const text = textOf(tree)
    const tokens = classTokens(tree)
    assert.ok(!text.includes('k:error.title'), 'a v1 snapshot must not hit the error card')
    for (const token of ['atw-header', 'atw-main', 'atw-collab', 'atw-lower', 'atw-flow-canvas', 'atw-topo-canvas']) {
      assert.ok(tokens.includes(token), `v1 board keeps ${token}`)
    }
    assert.equal(findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button').length, 2, 'both v1 items render')
    assert.ok(text.includes('k:channel.empty'), 'channel panel shows its empty state')
    assert.ok(text.includes('k:proposal.empty'), 'proposal panel shows its empty state')
    assert.ok(!tokens.includes('atw-open-queue'), 'no open queue without collaboration')
    assert.ok(!tokens.includes('atw-edge--peer'), 'no peer edges without collaboration')
    for (const key of ['channel.title', 'proposal.title']) assert.ok(board.copyKeys.includes(key), `the ${key} panel must render`)
  } finally {
    board.dispose()
  }
})

test('v2 snapshot renders the channel stream, proposals, open queue, and peer edges', async () => {
  const board = await mountBoard(V2_SNAPSHOT)
  try {
    const tree = await board.render()
    const text = textOf(tree)
    const tokens = classTokens(tree)

    assert.ok(!text.includes('k:error.title'), 'a v2 snapshot must not hit the error card')
    assert.equal(findByClass(tree, 'atw-channel-item').length, V2_CHANNEL.length, 'one row per channel message')
    const channelText = findByClass(tree, 'atw-channel-item').map(textOf).join(' | ')
    for (const kind of ['question', 'answer', 'proposal', 'objection', 'handoff', 'ack', 'status']) {
      assert.ok(channelText.includes('k:channel.kind.' + kind), `kind badge ${kind}`)
    }
    assert.ok(text.includes('k:collab.fromTo'), 'from → to renders')
    assert.ok(board.copyKeys.includes('collab.team'), 'team broadcasts are translated')
    assert.ok(channelText.includes('W1'), 'item references render as chips')
    assert.ok(text.includes('k:channel.count'), 'the stream count hint renders')

    const proposalText = findByClass(tree, 'atw-proposal').map(textOf).join(' | ')
    assert.equal(findByClass(tree, 'atw-proposal').length, 2, 'one card per proposal')
    for (const needle of ['k:proposal.kind.dod', 'k:proposal.kind.review_policy', 'k:proposal.status.open', 'k:proposal.status.accepted', 'k:proposal.vote.yes', 'k:proposal.vote.no', 'k:proposal.vote.abstain', 'k:proposal.affected', 'k:proposal.resolution', 'k:proposal.blocking']) {
      assert.ok(proposalText.includes(needle), `proposal card is missing ${needle}`)
    }
    assert.ok(proposalText.includes('adopt it'), 'resolution text renders')
    assert.equal(findByClass(tree, 'atw-proposal--blocking').length, 1, 'an open DoD proposal is flagged blocking')

    const openCards = findByClass(tree, 'atw-open-card')
    assert.equal(openCards.length, 1, 'the open queue renders one unclaimed card')
    assert.ok(tokens.includes('atw-open-queue'), 'open-queue lane exists')
    assert.ok(textOf(openCards[0]).includes('W2'), 'open lane shows the item id')

    const cards = findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button')
    const cardText = (id) => textOf(cards.find((element) => textOf(element).includes(id)))
    assert.ok(cardText('W1').includes('k:flow.proposalsOpen'), 'open proposals badge on the item card')
    assert.ok(cardText('W3').includes('k:flow.claimed'), 'claim badge on the item card')
    assert.ok(cardText('W2').includes('k:flow.openAssignment'), 'unclaimed badge on an open-queue item')

    const peerEdges = findByClass(tree, 'atw-edge--peer')
    assert.equal(peerEdges.length, 2, 'only resolvable peer edges are drawn')
    assert.ok(peerEdges[0].props.style.strokeWidth > peerEdges[1].props.style.strokeWidth, 'message count weights the stroke')
    assert.ok(findByClass(tree, 'atw-edge--lead-muted').length > 0, 'Lead spokes are de-emphasized once peers talk')
    assert.equal(findByClass(tree, 'atw-legend-line--peer').length, 1, 'the topology legend gains a peer entry')
  } finally {
    board.dispose()
  }
})

test('v2 drawer shows the collaboration record; filters and Escape work', async () => {
  const board = await mountBoard(V2_SNAPSHOT)
  try {
    let tree = await board.render()
    const card = findByClass(tree, 'atw-card').find((element) => element.props?.role === 'button' && textOf(element).includes('W1'))
    card.props.onClick()
    tree = await board.render()
    const drawer = findByClass(tree, 'atw-drawer')[0]
    assert.ok(drawer !== undefined, 'clicking a card opens the drawer')
    const text = textOf(drawer)
    for (const needle of ['k:drawer.collab', 'k:drawer.thread', 'k:drawer.reviewRequests', 'k:drawer.relatedProposals', 'k:drawer.assignment', 'k:drawer.claim']) {
      assert.ok(text.includes(needle), `the drawer must show ${needle}`)
    }
    assert.ok(text.includes('F1 这个 finding 怎么修？'), 'thread messages render in the drawer')
    assert.ok(text.includes('rev-b'), 'review requests show the invited reviewer')

    for (const handler of [...board.keydown]) handler({ key: 'Escape' })
    tree = await board.render()
    assert.equal(findByClass(tree, 'atw-drawer').length, 0, 'Escape closes the drawer')

    findButtonByText(tree, 'k:channel.filter.question').props.onClick()
    tree = await board.render()
    const rows = findByClass(tree, 'atw-channel-item')
    assert.equal(rows.length, 1, 'the question filter narrows the stream')
    assert.ok(textOf(rows[0]).includes('k:channel.kind.question'))
    findButtonByText(tree, 'k:channel.filter.all').props.onClick()
    tree = await board.render()
    assert.equal(findByClass(tree, 'atw-channel-item').length, V2_CHANNEL.length, 'the all filter restores the stream')
  } finally {
    board.dispose()
  }
})

test('v2 collaboration caps: 60 channel rows and 32 proposals', async () => {
  const channel = Array.from({ length: 70 }, (_, index) => ({
    id: 'c' + index,
    at: new Date(Date.parse('2026-11-02T00:00:00.000Z') + index * 1000).toISOString(),
    from: 'impl-a',
    to: 'rev-b',
    kind: index % 2 === 0 ? 'question' : 'answer',
    text: 'msg-' + index,
    itemId: null,
  }))
  const proposals = Array.from({ length: 40 }, (_, index) => ({
    id: 'cap-p' + index,
    at: new Date(Date.parse('2026-11-02T00:00:00.000Z') + index * 1000).toISOString(),
    by: 'impl-a',
    kind: 'scope',
    itemId: null,
    text: 'proposal-' + index,
    status: 'open',
    votes: [],
    tally: { yes: 0, no: 0, abstain: 0, affected: 0, total: 3 },
    resolvedAt: null,
    resolution: null,
  }))
  const snapshot = {
    ...V2_SNAPSHOT,
    run: { ...V2_SNAPSHOT.run, collaboration: { ...V2_SNAPSHOT.run.collaboration, channel, proposals } },
  }
  const board = await mountBoard(snapshot)
  try {
    const tree = await board.render()
    assert.equal(findByClass(tree, 'atw-channel-item').length, 60, 'the channel caps at 60 rows')
    assert.equal(findByClass(tree, 'atw-proposal').length, 32, 'the proposal panel caps at 32 cards')
    const text = textOf(tree)
    assert.ok(text.includes('msg-69'), 'the newest message survives the cap')
    assert.ok(!text.includes('msg-9 '), 'messages older than the window are dropped')
  } finally {
    board.dispose()
  }
})

test('broken collaboration payloads render without crashing', async () => {
  const snapshot = {
    ...V2_SNAPSHOT,
    run: {
      ...V2_SNAPSHOT.run,
      collaboration: {
        channel: [null, 'nope', { kind: 'weird', text: 42, from: null }],
        proposals: [null, { votes: 'x', tally: 'y', status: 'nope', kind: 'nope' }],
        openQueue: 'W2',
        pendingReviews: [null],
        handoffs: [null, 7],
        edges: [null, { from: 'impl-a' }],
      },
      items: [{ id: 'W1', subject: null, status: 'pending', thread: 'x', claim: 'nope', reviewRequests: [null], handoffs: [null], openProposals: 'many' }],
    },
  }
  const board = await mountBoard(snapshot)
  try {
    const tree = await board.render()
    assert.ok(!textOf(tree).includes('k:error.title'), 'malformed collaboration data must not reach the error card')
    assert.ok(classTokens(tree).includes('atw-collab'), 'the collaboration row still renders')
  } finally {
    board.dispose()
  }
})

// ---------------------------------------------------------------------------
// Member autonomy + proposal liveness (docs/14 §4)
// ---------------------------------------------------------------------------

test('docs/14 contract: the board reads origin/createdBy and deadline/autoResolved/quorum', () => {
  for (const literal of ['item.origin', 'item.createdBy', 'proposal.deadline', 'proposal.autoResolved', 'proposal.quorum']) {
    assert.ok(source.includes(literal), `client.js must read ${JSON.stringify(literal)}`)
  }
  for (const token of ['atw-badge--member', 'atw-badge--auto']) {
    assert.ok(source.includes(token), `client.js must use the ${token} class`)
    assert.ok(source.includes('.' + token), `the component stylesheet must style .${token}`)
  }
  // A deadline is rendered as remaining time, so it needs its own formatter.
  assert.ok(source.includes('function deadlineLabel('), 'deadlines render through a dedicated remaining-time formatter')
  assert.ok(source.includes("'time.minutesLeft'"), 'the remaining minutes are translated')
})

/** V2 snapshot plus the docs/14 liveness fields (one future, one expired). */
const AUTONOMY_SNAPSHOT = (() => {
  const future = new Date(Date.now() + 14 * 60 * 1000).toISOString()
  const past = new Date(Date.now() - 60 * 1000).toISOString()
  const proposals = V2_SNAPSHOT.run.collaboration.proposals.map((proposal, index) =>
    index === 0
      ? { ...proposal, deadline: future, quorum: 2, autoResolved: false }
      : { ...proposal, deadline: past, quorum: 3, autoResolved: true },
  )
  const items = V2_SNAPSHOT.run.items.map((item, index) =>
    index === 2 ? { ...item, origin: 'member', createdBy: 'impl-b' } : { ...item, origin: 'plan', createdBy: null },
  )
  return {
    ...V2_SNAPSHOT,
    run: { ...V2_SNAPSHOT.run, items, collaboration: { ...V2_SNAPSHOT.run.collaboration, proposals } },
  }
})()

test('docs/14: member-created item and live proposals render their badges', async () => {
  const board = await mountBoard(AUTONOMY_SNAPSHOT)
  try {
    const tree = await board.render()
    const tokens = classTokens(tree)
    const text = textOf(tree)

    assert.ok(tokens.includes('atw-badge--member'), 'a member-created item uses the dedicated badge class')
    assert.ok(text.includes('k:flow.memberItem'), 'the member badge is translated')
    const memberBadge = findByClass(tree, 'atw-badge--member')[0]
    assert.ok(memberBadge !== undefined, 'member badge element')
    assert.ok(typeof memberBadge.props.title === 'string' && memberBadge.props.title.includes('impl-b'), 'createdBy is in the badge tooltip')
    assert.ok(board.copyKeys.includes('flow.createdBy{"name":"impl-b"}'), 'createdBy flows through t()')

    const cards = findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button')
    const cardText = (id) => textOf(cards.find((element) => textOf(element).includes(id)))
    assert.ok(!cardText('W1').includes('k:flow.memberItem'), 'planned items do not claim to be member-created')

    // Proposals render newest first: [0] is the auto-resolved (expired) one,
    // [1] the still-open one with a future deadline.
    const proposals = findByClass(tree, 'atw-proposal')
    assert.equal(proposals.length, 2)
    const expired = textOf(proposals[0])
    const running = textOf(proposals[1])
    assert.ok(expired.includes('k:proposal.deadlineExpired'), 'a past deadline reads as expired')
    assert.ok(expired.includes('k:proposal.autoResolved'), 'the auto-resolved wording renders')
    assert.ok(expired.includes('k:proposal.quorum'), 'the quorum note sits next to the tally')
    assert.ok(running.includes('k:proposal.deadline'), 'a running proposal shows its deadline')
    assert.ok(running.includes('k:time.minutesLeft'), 'the deadline reads as remaining time')
    assert.ok(running.includes('k:proposal.quorum'), 'the quorum note renders for open proposals too')
    assert.equal(findByClass(tree, 'atw-badge--auto').length, 1, 'only the auto-resolved proposal carries that badge')
    assert.ok(findByClass(tree, 'atw-proposal-deadline').length === 2, 'both deadlines render')
    assert.ok(typeof findByClass(tree, 'atw-proposal-deadline')[0].props.title === 'string', 'the deadline tooltip carries the absolute time')
  } finally {
    board.dispose()
  }
})

test('docs/14: boards without origin/deadline/quorum show no new badges and do not crash', async () => {
  // V2_SNAPSHOT predates docs/14: no origin/createdBy/deadline/autoResolved/quorum.
  const board = await mountBoard(V2_SNAPSHOT)
  try {
    const tree = await board.render()
    const tokens = classTokens(tree)
    const text = textOf(tree)
    assert.ok(!tokens.includes('atw-badge--member'), 'no member badge on a legacy board')
    assert.ok(!tokens.includes('atw-badge--auto'), 'no auto-resolved badge on a legacy board')
    for (const key of ['flow.memberItem', 'proposal.deadline', 'proposal.deadlineExpired', 'proposal.autoResolved', 'proposal.quorum']) {
      assert.ok(!text.includes('k:' + key), `a legacy board must not render ${key}`)
    }
    assert.ok(!text.includes('k:error.title'), 'missing new fields must not reach the error card')
    assert.ok(tokens.includes('atw-collab'), 'the legacy board still renders its collaboration row')
  } finally {
    board.dispose()
  }
})

// ---------------------------------------------------------------------------
// Board noise reduction + Git/PR badges (docs/16 §2.3/§3)
// ---------------------------------------------------------------------------

/** Clone the v2 fixture with a different roster/items/collaboration. */
function withSnapshot(overrides) {
  return {
    ...V2_SNAPSHOT,
    ...overrides,
    run: { ...V2_SNAPSHOT.run, ...(overrides.run ?? {}) },
    team: { ...V2_SNAPSHOT.team, ...(overrides.team ?? {}) },
  }
}

test('docs/16 topology: only participants are drawn, idle members fold into one node', async () => {
  // The three-row layout contract: 2fr/1.4fr + 2fr/1fr + thirds, a 240–320px
  // panel band with an internal scroller, and a single column at <=1180px.
  assert.match(source, /\.atw-main\{[^}]*grid-template-columns:minmax\(0,1fr\)/, 'flow and topology stack full width for a readable map')
  assert.ok(source.includes('grid-template-columns:minmax(0,2fr) minmax(0,1fr)'), 'channel + proposals row ratios')
  assert.ok(source.includes('grid-template-columns:repeat(3,minmax(0,1fr))'), 'event/gate/escalation thirds')
  assert.match(source, /\.atw-panel\{[^}]*min-height:240px[^}]*max-height:320px/, 'every panel keeps the 240–320px band')
  assert.ok(source.includes('@media (max-width:1180px)'), 'narrow screens collapse to one column')
  assert.match(source, /\.atw-panel-body\{[^}]*overflow:auto/, 'the panel body owns the scrollbar')

  const idle = Array.from({ length: 6 }, (_, index) => ({ name: 'idle-' + (index + 1), role: 'teammate', status: 'inactive', context: 'fresh' }))
  const busy = [
    { name: 'impl-a', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'rev-b', role: 'teammate', status: 'inactive', context: 'fresh' },
    { name: 'impl-b', role: 'teammate', status: 'running', context: 'fork' },
  ]
  // The Host fans a `to:"team"` broadcast out into an edge to every roster
  // member; those edges must not promote idle members back into the map.
  const fanOutEdges = [
    { from: 'impl-a', to: 'rev-b', count: 3, kinds: ['note'] },
    ...idle.map((member) => ({ from: 'impl-a', to: member.name, count: 2, kinds: ['status'] })),
  ]
  const board = await mountBoard(
    withSnapshot({
      team: { members: [...busy, ...idle] },
      run: { collaboration: { ...V2_SNAPSHOT.run.collaboration, edges: fanOutEdges } },
    }),
  )
  try {
    const tree = await board.render()
    const drawn = findByClass(tree, 'atw-node--member')
    assert.equal(drawn.length, busy.length, 'only members with work/review/channel activity are drawn')
    const idleNodes = findByClass(tree, 'atw-node--idle')
    assert.equal(idleNodes.length, 1, 'all idle members fold into exactly one node')
    assert.equal(String(idleNodes[0].props.style?.left ?? ''), '92%', 'the idle pill sits in the top-right corner, clear of edges')
    assert.equal(String(idleNodes[0].props.style?.top ?? ''), '10%')
    const idleText = textOf(idleNodes[0])
    assert.ok(idleText.includes('k:topology.idle'), 'the folded node is labelled with the idle count')
    assert.ok(String(idleNodes[0].props.title ?? '').includes('idle-1'), 'hovering lists the idle names')
    assert.ok(String(idleNodes[0].props.title ?? '').includes('idle-6'))
    assert.ok(!textOf(tree).includes('idle-2'), 'folded names are not rendered as separate nodes')
  } finally {
    board.dispose()
  }

  // >6 participants switch the members band to two rows (no overlap at 9 people).
  const wide = [
    ...busy,
    { name: 'p1', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'p2', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'p3', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'p4', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'p5', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'p6', role: 'teammate', status: 'running', context: 'fresh' },
  ]
  const nine = await mountBoard(withSnapshot({ team: { members: wide } }))
  try {
    const tree = await nine.render()
    const nodes = findByClass(tree, 'atw-node--member')
    assert.equal(nodes.length, 9, 'nine participants stay visible')
    const tops = new Set(nodes.map((node) => String(node.props.style?.top ?? '')))
    assert.equal(tops.size, 2, 'more than six participants use a two-row grid')
    for (const node of nodes) assert.equal(node.props.style?.maxWidth, undefined, 'participant names are not width-capped')
  } finally {
    nine.dispose()
  }
})

test('docs/16 topology: peer edges are capped at the 8 busiest and weighted', async () => {
  const names = ['impl-a', 'rev-b', 'impl-b', 'p1', 'p2']
  const members = names.map((name) => ({ name, role: 'teammate', status: 'running', context: 'fresh' }))
  const pairs = []
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) pairs.push([names[left], names[right]])
  }
  // 10 peer pairs, counts 10..1 plus two sub-threshold edges.
  const edges = pairs.map(([from, to], index) => ({ from, to, count: 10 - index, kinds: ['note'] }))
  edges.push({ from: 'impl-a', to: 'p1', count: 1, kinds: ['note'] })
  edges.push({ from: 'rev-b', to: 'p2', count: 1, kinds: ['note'] })
  const board = await mountBoard(
    withSnapshot({
      team: { members },
      run: { collaboration: { ...V2_SNAPSHOT.run.collaboration, edges } },
    }),
  )
  try {
    const tree = await board.render()
    const peers = findByClass(tree, 'atw-edge--peer')
    assert.equal(peers.length, 8, 'at most eight peer links are drawn')
    const svg = findByClass(tree, 'atw-topo-svg')[0]
    const paths = collectElements(svg, (element) => element.type === 'path')
    assert.ok(String(paths[0].props?.className ?? '').includes('atw-edge--peer'), 'peer arcs are painted under the Lead spokes')
    const counts = peers.map((path) => {
      const match = /·\s*(\d+)/.exec(textOf(path))
      return match === null ? 0 : Number(match[1])
    })
    assert.deepEqual(counts, [10, 9, 8, 7, 6, 5, 4, 3].slice(0, counts.length), 'the busiest links win')
    for (const count of counts) assert.ok(count >= 2, 'count >= 2 keeps the map readable')
    const widths = peers.map((path) => Number(path.props.style.strokeWidth))
    assert.ok(widths[0] > widths[widths.length - 1], 'message count weights the stroke')
    for (const width of widths) assert.ok(width >= 0.8 && width <= 2.4, `stroke width stays in 0.8..2.4 (${width})`)
    for (const opacity of peers.map((path) => Number(path.props.style.opacity))) {
      assert.ok(opacity >= 0.25 && opacity <= 0.55, `opacity stays in 0.25..0.55 (${opacity})`)
    }
  } finally {
    board.dispose()
  }

  // Four or fewer drawn nodes relax the threshold so the map is not empty.
  const smallBoard = await mountBoard(
    withSnapshot({
      team: { members: members.slice(0, 3) },
      run: { collaboration: { ...V2_SNAPSHOT.run.collaboration, edges: [{ from: 'impl-a', to: 'rev-b', count: 1, kinds: ['note'] }] } },
    }),
  )
  try {
    const tree = await smallBoard.render()
    assert.equal(findByClass(tree, 'atw-edge--peer').length, 1, 'a small participant set may draw single-message links')
  } finally {
    smallBoard.dispose()
  }
})

test('docs/16: card badges stay within budget and Git/PR badges render (and vanish safely)', async () => {
  const gitFull = {
    branch: 'agentteam/run-v2/W1',
    base: 'main',
    sha: 'abc1234def',
    remote: 'origin',
    pushed: true,
    verify: { ok: true, at: new Date().toISOString() },
    pr: { url: 'https://github.com/o/r/pull/7', number: 7, mode: 'gh', status: 'open' },
    mergedAt: null,
  }
  const gitManual = {
    branch: 'agentteam/run-v2/W2',
    base: 'main',
    sha: '',
    remote: 'origin',
    pushed: false,
    verify: { ok: false, at: new Date().toISOString() },
    pr: { url: '', mode: 'manual' },
    mergedAt: new Date().toISOString(),
  }
  const items = V2_SNAPSHOT.run.items.map((item, index) =>
    index === 0 ? { ...item, git: gitFull } : index === 1 ? { ...item, git: gitManual } : item,
  )
  const board = await mountBoard(withSnapshot({ run: { items } }))
  try {
    let tree = await board.render()
    const cards = findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button')
    const cardFor = (id) => cards.find((element) => textOf(element).includes(id))
    // Noise budget: status lives in the head, so at most two children remain in the flags row.
    for (const card of cards) {
      const flags = findByClass(card, 'atw-card-flags')
      assert.equal(flags.length, 1, 'every card keeps one flags row')
      assert.ok((flags[0].children ?? []).filter(Boolean).length <= 2, 'flags stay within the status + R + one-flag budget')
    }
    const w1 = textOf(cardFor('W1'))
    assert.ok(w1.includes('k:git.branch'), 'branch badge')
    assert.ok(w1.includes('k:git.pushed'), 'pushed badge')
    assert.ok(w1.includes('k:git.verifyOk'), 'verified badge')
    assert.ok(w1.includes('k:git.pr'), 'PR badge')
    const links = collectElements(tree, (element) => element.type === 'a' && element.props?.href === gitFull.pr.url)
    assert.equal(links.length, 1, 'a gh-mode PR renders as an external link')
    assert.ok(String(links[0].props.className).includes('atw-badge--link'))
    const w2 = textOf(cardFor('W2'))
    assert.ok(w2.includes('k:git.verifyFail'), 'a failed verify is called out')
    assert.ok(w2.includes('k:git.prUnknown'), 'a manual/no-number PR still shows a badge')
    assert.ok(w2.includes('k:git.merged'), 'a merged item shows the merged badge')
    assert.ok(!textOf(cardFor('W3')).includes('k:git.'), 'items without a git record show no git badges')

    // The drawer is the detail surface: branch/base/sha/remote/verify/PR/merged.
    cardFor('W1').props.onClick()
    tree = await board.render()
    const drawer = textOf(findByClass(tree, 'atw-drawer')[0])
    for (const needle of ['k:git.title', gitFull.branch, gitFull.sha, gitFull.remote, 'k:git.verifyOk']) {
      assert.ok(drawer.includes(needle), `the Git/PR drawer block is missing ${needle}`)
    }
    assert.ok(drawer.includes(gitFull.pr.url), 'the drawer links the PR url')
    for (const handler of [...board.keydown]) handler({ key: 'Escape' })
    tree = await board.render()
    assert.equal(findByClass(tree, 'atw-drawer').length, 0)
  } finally {
    board.dispose()
  }

  // Real Host aggregation: shallow `item.git` (sha/commits/verify/prReview) plus a
  // run-level `run.git` (branch/push/PR), which the client must merge defensively.
  const hostShapeItems = V2_SNAPSHOT.run.items.map((item, index) =>
    index === 0
      ? {
          ...item,
          git: {
            sha: 'deadbee',
            commits: [{ sha: 'deadbee', at: new Date().toISOString(), message: 'agentteam(W1): x', files: ['a.js'] }],
            verify: { ok: true, at: new Date().toISOString(), results: [{ command: 'node --test', exitCode: 0, outputTail: '' }] },
            prReview: { verdict: 'approve', at: new Date().toISOString(), mode: 'gh' },
          },
        }
      : item,
  )
  const hostShape = await mountBoard(
    withSnapshot({
      run: {
        items: hostShapeItems,
        git: {
          branch: 'agentteam/run-2',
          base: 'main',
          remote: 'origin',
          branchCreated: true,
          pushedSha: 'deadbee',
          pushedAt: new Date().toISOString(),
          pr: { url: 'https://github.com/o/r/pull/9', number: 9, mode: 'gh', status: 'OPEN' },
          mergedAt: null,
        },
      },
    }),
  )
  try {
    let tree = await hostShape.render()
    const cards = findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button')
    const cardFor = (id) => cards.find((element) => textOf(element).includes(id))
    const w1 = textOf(cardFor('W1'))
    assert.ok(w1.includes('k:git.branch') && w1.includes('agentteam/run-2'), 'the run branch enriches the item badges')
    assert.ok(w1.includes('k:git.pushed'), 'run.git.pushedAt marks the branch as pushed')
    assert.ok(w1.includes('k:git.verifyOk'), 'item verify result renders')
    assert.ok(w1.includes('k:git.pr'), 'the run pull request renders on the card')
    const prLinks = collectElements(tree, (element) => element.type === 'a' && element.props?.href === 'https://github.com/o/r/pull/9')
    assert.equal(prLinks.length, 1, 'the run PR is clickable')
    assert.ok(!textOf(cardFor('W2')).includes('k:git.'), 'items without their own git record stay clean')

    cardFor('W1').props.onClick()
    tree = await hostShape.render()
    const drawer = textOf(findByClass(tree, 'atw-drawer')[0])
    for (const needle of ['agentteam/run-2', 'main', 'origin', 'deadbee', 'https://github.com/o/r/pull/9', 'k:git.prReview', 'node --test']) {
      assert.ok(drawer.includes(needle), `the drawer is missing ${needle}`)
    }
  } finally {
    hostShape.dispose()
  }

  // Legacy snapshot: no `item.git` at all → no git badges/section, no crash.
  const legacy = await mountBoard(V2_SNAPSHOT)
  try {
    const tree = await legacy.render()
    const tokens = classTokens(tree)
    const text = textOf(tree)
    assert.ok(!tokens.includes('atw-card-git'), 'no git row without data')
    assert.ok(!tokens.includes('atw-badge--git'), 'no git badges without data')
    assert.ok(!text.includes('k:git.'), 'no git copy without data')
    assert.ok(!text.includes('k:error.title'), 'missing git data must not reach the error card')
  } finally {
    legacy.dispose()
  }
})

// ---------------------------------------------------------------------------
// v1.3 live-run polish (docs/17): channel clamp, overdue chip, density fixes
// ---------------------------------------------------------------------------

test('docs/17 channel: long bodies clamp to four lines and expand per message', async () => {
  const longText = '这是一条很长的协作消息，需要折叠起来，避免把频道撑爆。'.repeat(8)
  const channel = [
    ...V2_CHANNEL,
    { id: 'm-long', at: '2026-11-02T00:00:09.000Z', from: 'impl-a', to: 'team', kind: 'note', text: longText, itemId: null },
  ]
  const board = await mountBoard(withSnapshot({ run: { collaboration: { ...V2_SNAPSHOT.run.collaboration, channel } } }))
  try {
    let tree = await board.render()
    assert.match(source, /\.atw-channel-text\{[^}]*-webkit-line-clamp:4/, 'channel bodies clamp at four lines')
    const items = findByClass(tree, 'atw-channel-item')
    assert.equal(items.length, channel.length, 'clamp does not change the row count')
    assert.equal(findByClass(tree, 'atw-channel-head').length, channel.length, 'headers stay intact')
    const toggles = findByClass(tree, 'atw-channel-toggle')
    assert.equal(toggles.length, 1, 'only the overflowing body gets a toggle')
    assert.equal(textOf(toggles[0]), 'k:channel.expand', 'collapsed label is the expand copy')

    const longRow = () => findByClass(tree, 'atw-channel-item').find((row) => textOf(row).includes('避免把频道撑爆'))
    assert.ok(!String(findByClass(longRow(), 'atw-channel-text')[0].props.className).includes('--expanded'), 'starts clamped')

    findButtonByText(tree, 'k:channel.expand').props.onClick()
    tree = await board.render()
    assert.ok(String(findByClass(longRow(), 'atw-channel-text')[0].props.className).includes('atw-channel-text--expanded'), 'expands just that message')
    assert.equal(textOf(findButtonByText(tree, 'k:channel.collapse')), 'k:channel.collapse', 'the toggle flips to collapse')

    findButtonByText(tree, 'k:channel.collapse').props.onClick()
    tree = await board.render()
    assert.ok(!String(findByClass(longRow(), 'atw-channel-text')[0].props.className).includes('--expanded'), 'collapses back')
    assert.equal(textOf(findButtonByText(tree, 'k:channel.expand')), 'k:channel.expand')
  } finally {
    board.dispose()
  }
})

test('docs/17 proposals: an expired, not-yet-resolved proposal shows the overdue chip', async () => {
  const now = Date.now()
  const past = new Date(now - 5 * 60000).toISOString()
  const future = new Date(now + 15 * 60000).toISOString()
  const base = {
    by: 'impl-a',
    kind: 'dod',
    itemId: 'W1',
    status: 'open',
    votes: [],
    tally: { yes: 0, no: 0, abstain: 0, affected: 2, total: 4 },
    resolvedAt: null,
    resolution: null,
    quorum: 2,
  }
  const proposals = [
    { ...base, id: 'p-overdue', at: past, text: '过期未裁决的提案', deadline: past, autoResolved: false },
    { ...base, id: 'p-auto', at: past, text: '超时已裁决的提案', status: 'accepted', deadline: past, autoResolved: true },
    { ...base, id: 'p-future', at: past, text: '未来才截止的提案', deadline: future, autoResolved: false },
  ]
  const board = await mountBoard(withSnapshot({ run: { collaboration: { ...V2_SNAPSHOT.run.collaboration, proposals } } }))
  try {
    const tree = await board.render()
    const cards = findByClass(tree, 'atw-proposal')
    const cardFor = (needle) => cards.find((card) => textOf(card).includes(needle))
    const overdueCard = cardFor('过期未裁决的提案')
    assert.ok(textOf(overdueCard).includes('k:proposal.overdue'), 'expired + not auto-resolved gets the warn chip')
    const chips = findByClass(overdueCard, 'atw-badge--warn')
    assert.ok(chips.length >= 1, 'the chip uses the warn tone')
    assert.ok(textOf(chips[0]).includes('k:proposal.overdue'))
    const autoCard = cardFor('超时已裁决的提案')
    assert.ok(textOf(autoCard).includes('k:proposal.autoResolved'), 'auto-resolved keeps its own badge')
    assert.ok(!textOf(autoCard).includes('k:proposal.overdue'), 'auto-resolved proposals are not marked overdue')
    assert.ok(!textOf(cardFor('未来才截止的提案')).includes('k:proposal.overdue'), 'a future deadline is not overdue')
  } finally {
    board.dispose()
  }
})

test('docs/17 density: idle excludes the Lead, the flow panel is 520px, cards clamp their title', async () => {
  assert.match(source, /\.atw-panel--flow\{max-height:520px\}/, 'the flow panel opts into the 520px box')
  assert.match(source, /\.atw-panel\{[^}]*max-height:320px/, 'other panels keep the 320px box')
  assert.match(source, /\.atw-card-subject\{[^}]*-webkit-line-clamp:2/, 'card titles clamp at two lines')
  assert.match(source, /\.atw-card-flags\{[^}]*margin-top:auto/, 'the flags row is pinned to the card bottom')

  // Roster that only contains the Lead must not produce an idle node.
  const lead = { name: 'lead', role: 'lead', status: 'inactive', context: 'fresh' }
  const leadOnly = await mountBoard(withSnapshot({ team: { members: [lead] } }))
  try {
    const tree = await leadOnly.render()
    assert.equal(findByClass(tree, 'atw-node--idle').length, 0, 'the Lead is never folded into the idle node')
    assert.ok(!textOf(tree).includes('k:topology.idle'), 'no idle hint when nothing is idle')
    assert.equal(findByClass(tree, 'atw-node--lead').length, 1, 'the Lead keeps its own node')
    assert.equal(findByClass(tree, 'atw-panel--flow').length, 1, 'exactly the flow panel uses the taller modifier')
  } finally {
    leadOnly.dispose()
  }

  const mixed = await mountBoard(
    withSnapshot({
      team: {
        members: [
          lead,
          { name: 'idle-1', role: 'teammate', status: 'inactive', context: 'fresh' },
          { name: 'idle-2', role: 'teammate', status: 'inactive', context: 'fresh' },
          { name: 'idle-3', role: 'teammate', status: 'inactive', context: 'fresh' },
        ],
      },
    }),
  )
  try {
    const tree = await mixed.render()
    const idleNodes = findByClass(tree, 'atw-node--idle')
    assert.equal(idleNodes.length, 1, 'the folded node still renders when members are idle')
    assert.ok(textOf(idleNodes[0]).includes('"n":3'), 'the idle count excludes the Lead')
  } finally {
    mixed.dispose()
  }

  // A card without a Git row is shorter, so its bottom-anchored flags leave no gap.
  const items = V2_SNAPSHOT.run.items.map((item, index) =>
    index === 0
      ? { ...item, git: { branch: 'agentteam/x', sha: 'abc1234', verify: { ok: true }, pr: null, mergedAt: null } }
      : item,
  )
  const dense = await mountBoard(withSnapshot({ run: { items } }))
  try {
    const tree = await dense.render()
    const cards = findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button')
    const cardFor = (id) => cards.find((element) => textOf(element).includes(id))
    const heightOf = (card) => Number(String(card.props.style.height).replace('px', ''))
    const withGit = cardFor('W1')
    const noGit = cardFor('W2')
    assert.equal(heightOf(withGit), 152, 'cards with a Git row keep the full height')
    assert.equal(heightOf(noGit), 132, 'cards without a Git row are shorter')
    const flags = findByClass(noGit, 'atw-card-flags')[0]
    const children = (noGit.children ?? []).filter((child) => child !== null && child !== undefined)
    assert.equal(children[children.length - 1], flags, 'the flags row is the last card row (bottom-anchored)')
  } finally {
    dense.dispose()
  }
})

// ---------------------------------------------------------------------------
// v1.4 member panel, plan-first and graceful-stop (docs/19 §4/§5)
// ---------------------------------------------------------------------------

/** Build one member-route GET payload with sensible defaults. */
function memberPayload(overrides = {}) {
  return {
    ok: true,
    member: {
      name: 'impl-a',
      role: 'implementer',
      status: 'running',
      context: 'fresh',
      currentItems: [],
      recentActivity: [],
      channel: [],
      stop: null,
      plan: null,
      roleDefinition: null,
      ...overrides,
    },
  }
}

/** @returns the rendered topology node for one member name. */
function findMemberNode(tree, name) {
  return findByClass(tree, 'atw-node--member').find((element) => textOf(element).includes(name))
}

test('docs/19 member drawer: opens from a topology node and renders the member payload', async () => {
  const payload = memberPayload({
    name: 'impl-a',
    currentItems: [{ id: 'W1', subject: 'v1 item', status: 'in_review', role: 'implementer' }],
    recentActivity: [{ at: '2026-11-02T00:00:20.000Z', type: 'report/submitted', detail: 'W1' }],
    channel: [{ id: 'm9', at: '2026-11-02T00:00:21.000Z', from: 'impl-a', to: 'rev-b', kind: 'answer', text: 'contract is X', item_id: 'W1' }],
    stop: { id: 'stop1', status: 'pending', at: '2026-11-02T00:00:22.000Z' },
    plan: { itemId: 'W1', status: 'pending' },
    roleDefinition: { role: 'implementer', provider: 'review-fast', prompt: 'You focus on auth and injection risks.' },
  })
  const snapshot = withSnapshot({
    run: {
      collaboration: {
        ...V2_SNAPSHOT.run.collaboration,
        stops: [{ id: 'stop1', at: '2026-11-02T00:00:22.000Z', by: 'lead', target: 'impl-a', mode: 'graceful', status: 'pending', reason: 'round finished', decidedAt: null }],
      },
    },
  })
  const board = await mountBoard(snapshot, { member: () => ({ status: 200, body: payload }) })
  try {
    let tree = await board.render()
    assert.equal(findByClass(tree, 'atw-node-stop').length, 1, 'a pending stop paints one warn dot on the topology')
    assert.ok(String(findByClass(tree, 'atw-node-stop')[0].props.title).includes('k:member.stop.pending'))
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await board.render()
    const drawers = findByClass(tree, 'atw-member')
    assert.equal(drawers.length, 1, 'the member drawer opens')
    const text = textOf(drawers[0])
    for (const needle of [
      'k:member.title',
      'impl-a',
      'k:member.role',
      'k:member.status',
      'k:member.items',
      'W1',
      'k:member.activity',
      'report/submitted',
      'k:member.channel',
      'contract is X',
      'k:member.roleDefinition',
      'review-fast',
      'You focus on auth and injection risks.',
      'k:member.plan',
      'k:plan.pending',
      'k:member.stopState',
      'k:member.stop.pending',
    ]) {
      assert.ok(text.includes(needle), 'member drawer is missing ' + needle)
    }
    assert.equal(findByClass(tree, 'atw-member-input').length, 1, 'the composer input renders')
    assert.equal(findByClass(tree, 'atw-member-send').length, 1, 'the send button renders')
    assert.match(source, /\.atw-member-channel-text\{[^}]*-webkit-line-clamp:3/, 'related channel bodies clamp at three lines')
    const gets = board.requests.filter((entry) => entry.url.indexOf('/api/agent-team-workflow.member') !== -1 && entry.method === 'GET')
    assert.equal(gets.length, 1, 'the drawer fetches the member route once per open')
    assert.ok(gets[0].url.includes('session=session-1'), 'the route carries the session id')
    assert.ok(gets[0].url.includes('name=impl-a'), 'the route carries the member name')

    // A poll tick refreshes the open drawer: the header refresh forces the next
    // snapshot, and the member effect keys on `lastUpdated`.
    findButtonByText(tree, 'k:header.refresh').props.onClick()
    tree = await board.render()
    const refetched = board.requests.filter((entry) => entry.url.indexOf('/api/agent-team-workflow.member') !== -1 && entry.method === 'GET')
    assert.equal(refetched.length, 2, 'an open drawer refetches the member view on the next tick')
  } finally {
    board.dispose()
  }

  // The empty-state member rows are click targets too (same open action).
  const emptyBoard = await mountBoard({ ...V2_SNAPSHOT, run: null }, { member: () => ({ status: 200, body: payload }) })
  try {
    let tree = await emptyBoard.render()
    const rows = findByClass(tree, 'atw-member-line--button')
    assert.ok(rows.length > 0, 'the empty state still lists the roster')
    rows.find((row) => textOf(row).includes('impl-a')).props.onClick()
    tree = await emptyBoard.render()
    assert.equal(findByClass(tree, 'atw-member').length, 1, 'a member row opens the same drawer')
  } finally {
    emptyBoard.dispose()
  }
})

test('docs/19 member drawer: sending a message posts the route and reports success/failure/empty', async () => {
  const calls = []
  const board = await mountBoard(
    withSnapshot({}),
    {
      member: ({ method, body }) => {
        if (method === 'POST') {
          calls.push(body)
          return { status: 200, body: { ok: true, delivered: true, member: 'impl-a' } }
        }
        return { status: 200, body: memberPayload() }
      },
    },
  )
  try {
    let tree = await board.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await board.render()

    // Empty input is rejected locally: the route answers 400 by contract.
    findByClass(tree, 'atw-member-send')[0].props.onClick()
    tree = await board.render()
    assert.ok(textOf(findByClass(tree, 'atw-member')[0]).includes('k:member.emptyMessage'), 'empty message is called out')
    assert.equal(calls.length, 0, 'an empty message is never posted')

    findByClass(tree, 'atw-member-input')[0].props.onChange({ target: { value: '  hello member  ' } })
    tree = await board.render()
    assert.equal(findByClass(tree, 'atw-member-input')[0].props.value, '  hello member  ')
    findByClass(tree, 'atw-member-send')[0].props.onClick()
    tree = await board.render()
    const drawerText = textOf(findByClass(tree, 'atw-member')[0])
    assert.ok(drawerText.includes('k:member.sent'), 'success is reported')
    assert.equal(findByClass(tree, 'atw-member-input')[0].props.value, '', 'the input is cleared on success')
    assert.equal(calls.length, 1, 'exactly one POST happened')
    assert.deepEqual(JSON.parse(calls[0]), { name: 'impl-a', message: 'hello member' }, 'the body carries the trimmed message')
  } finally {
    board.dispose()
  }

  const failing = await mountBoard(
    withSnapshot({}),
    {
      member: ({ method }) =>
        method === 'POST'
          ? { status: 409, body: { ok: false, error: 'the message was rejected' } }
          : { status: 200, body: memberPayload() },
    },
  )
  try {
    let tree = await failing.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await failing.render()
    findByClass(tree, 'atw-member-input')[0].props.onChange({ target: { value: 'please continue' } })
    tree = await failing.render()
    findByClass(tree, 'atw-member-send')[0].props.onClick()
    tree = await failing.render()
    const text = textOf(findByClass(tree, 'atw-member')[0])
    assert.ok(text.includes('k:member.error'), 'a rejected POST surfaces an error')
    assert.ok(text.includes('the message was rejected'), 'the route error message is shown')
    assert.ok(!text.includes('k:member.sent'), 'no success is claimed on failure')
  } finally {
    failing.dispose()
  }
})

test('docs/19 plan-first: card badges and the item drawer plan block', async () => {
  const planSteps = ['read quote.mjs', 'run node --test']
  const planFiles = ['collab-live-2/quote.mjs']
  const planRisks = ['empty input contract']
  const base = { steps: planSteps, files: planFiles, risks: planRisks, decidedBy: '', reason: '' }
  const rejectedItem = { ...V2_SNAPSHOT.run.items[2], id: 'W4', subject: 'plan rejected item', wave: 2 }
  const items = [
    { ...V2_SNAPSHOT.run.items[0], plan: { ...base, status: 'pending' } },
    { ...V2_SNAPSHOT.run.items[1], plan: { ...base, status: 'approved', decidedBy: 'lead', reason: 'looks fine' } },
    V2_SNAPSHOT.run.items[2],
    { ...rejectedItem, plan: { ...base, status: 'rejected', decidedBy: 'lead', reason: 'missing tests' } },
  ]
  const board = await mountBoard(withSnapshot({ run: { items } }))
  try {
    let tree = await board.render()
    const cards = findByClass(tree, 'atw-card').filter((element) => element.props?.role === 'button')
    const cardFor = (id) => cards.find((element) => textOf(element).includes(id))
    const pendingCard = cardFor('W1')
    assert.ok(textOf(pendingCard).includes('k:plan.pending'), 'pending plan badge')
    assert.ok(
      findByClass(pendingCard, 'atw-badge--warn').some((badgeElement) => textOf(badgeElement).includes('k:plan.pending')),
      'pending plan uses the warn tone',
    )
    const approvedCard = cardFor('W2')
    assert.ok(textOf(approvedCard).includes('k:plan.approved'), 'approved plan badge')
    assert.ok(
      findByClass(approvedCard, 'atw-badge--success').some((badgeElement) => textOf(badgeElement).includes('k:plan.approved')),
      'approved plan uses the success tone',
    )
    const rejectedCard = cardFor('W4')
    assert.ok(textOf(rejectedCard).includes('k:plan.rejected'), 'rejected plan badge')
    assert.ok(
      findByClass(rejectedCard, 'atw-badge--error').some((badgeElement) => textOf(badgeElement).includes('k:plan.rejected')),
      'rejected plan uses the error tone',
    )
    assert.ok(!textOf(cardFor('W3')).includes('k:plan.'), 'items without a plan show no plan badge')

    cardFor('W4').props.onClick()
    tree = await board.render()
    const drawer = textOf(findByClass(tree, 'atw-drawer')[0])
    for (const needle of ['k:plan.title', 'k:plan.status', 'k:plan.rejected', 'k:plan.steps', 'read quote.mjs', 'k:plan.files', 'collab-live-2/quote.mjs', 'k:plan.risks', 'empty input contract', 'k:plan.reason', 'missing tests', 'k:plan.decidedBy', 'lead']) {
      assert.ok(drawer.includes(needle), 'plan drawer is missing ' + needle)
    }
  } finally {
    board.dispose()
  }
})

test('docs/19 graceful stop: drawer shows every stop status and only pending paints a dot', async () => {
  const stops = [
    { id: 's1', at: '2026-11-02T00:00:30.000Z', by: 'lead', target: 'impl-a', mode: 'graceful', status: 'pending', reason: '', decidedAt: null },
    { id: 's2', at: '2026-11-02T00:00:31.000Z', by: 'lead', target: 'rev-b', mode: 'graceful', status: 'accepted', reason: '', decidedAt: '2026-11-02T00:00:32.000Z' },
    { id: 's3', at: '2026-11-02T00:00:33.000Z', by: 'lead', target: 'impl-b', mode: 'graceful', status: 'rejected', reason: '', decidedAt: '2026-11-02T00:00:34.000Z' },
    { id: 's4', at: '2026-11-02T00:00:35.000Z', by: 'lead', target: 'impl-c', mode: 'interrupt', status: 'interrupted', reason: '', decidedAt: '2026-11-02T00:00:36.000Z' },
  ]
  const members = [
    ...V2_SNAPSHOT.team.members,
    { name: 'impl-c', role: 'teammate', status: 'running', context: 'fresh' },
  ]
  const stopByMember = { 'impl-a': 'pending', 'rev-b': 'accepted', 'impl-b': 'rejected', 'impl-c': 'interrupted' }
  const board = await mountBoard(withSnapshot({ run: { collaboration: { ...V2_SNAPSHOT.run.collaboration, stops } }, team: { members } }), {
    member: ({ url }) => {
      const match = /[?&]name=([^&]+)/.exec(url)
      const name = match === null ? 'impl-a' : decodeURIComponent(match[1])
      return {
        status: 200,
        body: memberPayload({
          name,
          // impl-c exercises the run-level fallback: the route reports no stop.
          stop: name === 'impl-c' ? null : { id: 's-' + name, status: stopByMember[name], at: '2026-11-02T00:00:30.000Z' },
        }),
      }
    },
  })
  try {
    let tree = await board.render()
    assert.equal(findByClass(tree, 'atw-node-stop').length, 1, 'only the pending stop marks the topology')
    const expectations = [
      ['impl-a', 'k:member.stop.pending'],
      ['rev-b', 'k:member.stop.accepted'],
      ['impl-b', 'k:member.stop.rejected'],
      ['impl-c', 'k:member.stop.interrupted'],
    ]
    for (const [name, needle] of expectations) {
      findMemberNode(tree, name).props.onClick()
      tree = await board.render()
      const text = textOf(findByClass(tree, 'atw-member')[0])
      assert.ok(text.includes(needle), name + ' drawer should show ' + needle)
      assert.equal(findByClass(tree, 'atw-node-stop').length, 1, 'the dot stays tied to the pending stop')
    }
  } finally {
    board.dispose()
  }
})

// ---------------------------------------------------------------------------
// v1.5 member transcript section (docs/21)
// ---------------------------------------------------------------------------

test('docs/21 member transcript: renders roles, bodies and the truncation hint', async () => {
  let getCount = 0
  const firstTranscript = {
    available: true,
    messages: [
      { seq: 1, role: 'user', text: 'please implement quoteName' },
      { seq: 2, role: 'assistant', text: 'I will read quote.mjs first' },
      { seq: 3, role: 'system', text: 'system note: plan approved' },
      { seq: null, role: 'tool', text: '[tool] bash {"command":"node --test"}' },
    ],
    truncated: true,
    totalEvents: 120,
    error: null,
  }
  const refreshedTranscript = {
    ...firstTranscript,
    messages: [...firstTranscript.messages, { seq: 4, role: 'assistant', text: 'refreshed transcript line' }],
    truncated: false,
  }
  const board = await mountBoard(withSnapshot({}), {
    member: ({ method }) => {
      if (method === 'POST') return { status: 200, body: { ok: true, delivered: true } }
      getCount += 1
      return { status: 200, body: memberPayload({ transcript: getCount > 1 ? refreshedTranscript : firstTranscript }) }
    },
  })
  try {
    let tree = await board.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await board.render()
    const drawer = findByClass(tree, 'atw-member')[0]
    assert.equal(findByClass(drawer, 'atw-member-transcript').length, 1, 'the transcript section renders')
    const text = textOf(drawer)
    for (const needle of [
      'k:member.transcript',
      'k:member.role.user',
      'k:member.role.assistant',
      'k:member.role.system',
      'k:member.role.tool',
      'please implement quoteName',
      'I will read quote.mjs first',
      'system note: plan approved',
      '[tool] bash',
      'k:member.transcriptTruncated',
      '"n":4',
    ]) {
      assert.ok(text.includes(needle), 'transcript is missing ' + needle)
    }
    const roleTones = {
      'k:member.role.user': 'atw-badge--brand',
      'k:member.role.assistant': 'atw-badge--success',
      'k:member.role.system': 'atw-badge--idle',
      'k:member.role.tool': 'atw-badge--warn',
    }
    for (const [label, tone] of Object.entries(roleTones)) {
      const matches = collectElements(drawer, (element) => textOf(element).includes(label) && String(element.props?.className ?? '').includes(tone))
      assert.ok(matches.length > 0, label + ' should use ' + tone)
    }
    const items = findByClass(drawer, 'atw-member-transcript-item')
    assert.equal(items.length, 4, 'one row per transcript message')
    assert.ok(textOf(items[0]).includes('please implement quoteName'), 'messages keep their order')
    assert.ok(textOf(items[3]).includes('[tool] bash'), 'the tool summary stays last')
    assert.match(source, /\.atw-member-transcript-text\{[^}]*-webkit-line-clamp:3/, 'transcript bodies clamp at three lines')

    // The transcript travels with the member payload, so the next poll updates it.
    findButtonByText(tree, 'k:header.refresh').props.onClick()
    tree = await board.render()
    assert.ok(textOf(findByClass(tree, 'atw-member')[0]).includes('refreshed transcript line'), 'polling refreshes the transcript')
  } finally {
    board.dispose()
  }
})

test('docs/21 member transcript: unavailable, empty and legacy payloads degrade gracefully', async () => {
  const unavailableBoard = await mountBoard(withSnapshot({}), {
    member: () => ({
      status: 200,
      body: memberPayload({ transcript: { available: false, messages: [], truncated: false, totalEvents: 0, error: 'session query service is not available' } }),
    }),
  })
  try {
    let tree = await unavailableBoard.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await unavailableBoard.render()
    const drawer = findByClass(tree, 'atw-member')[0]
    assert.ok(textOf(drawer).includes('k:member.transcriptUnavailable'), 'the unavailable copy renders')
    assert.ok(textOf(drawer).includes('k:member.items'), 'the rest of the member view still renders')
    const titled = collectElements(drawer, (element) => String(element.props?.title ?? '').includes('session query service is not available'))
    assert.ok(titled.length > 0, 'the route error is kept as a tooltip')
    assert.ok(!textOf(drawer).includes('k:error.title'), 'an unavailable transcript does not crash the board')
  } finally {
    unavailableBoard.dispose()
  }

  const emptyBoard = await mountBoard(withSnapshot({}), {
    member: () => ({ status: 200, body: memberPayload({ transcript: { available: true, messages: [], truncated: false, totalEvents: 0, error: null } }) }),
  })
  try {
    let tree = await emptyBoard.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await emptyBoard.render()
    const drawer = findByClass(tree, 'atw-member')[0]
    assert.ok(textOf(drawer).includes('k:member.transcriptEmpty'), 'an available but empty transcript says so')
    assert.ok(!textOf(drawer).includes('k:member.transcriptUnavailable'), 'empty is not reported as unavailable')
  } finally {
    emptyBoard.dispose()
  }

  // Older route payload without `transcript` at all: degrade, never throw.
  const legacyBoard = await mountBoard(withSnapshot({}), { member: () => ({ status: 200, body: memberPayload() }) })
  try {
    let tree = await legacyBoard.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await legacyBoard.render()
    const drawer = findByClass(tree, 'atw-member')[0]
    assert.ok(textOf(drawer).includes('k:member.transcriptUnavailable'), 'a missing transcript block degrades to unavailable')
    assert.ok(textOf(drawer).includes('k:member.stopState'), 'the drawer keeps its other sections')
    assert.ok(!textOf(drawer).includes('k:error.title'), 'a legacy payload does not crash the board')
  } finally {
    legacyBoard.dispose()
  }
})

// ---------------------------------------------------------------------------
// v1.6: per-message transcript expand + token usage panel
// ---------------------------------------------------------------------------

test('docs/21 member transcript: each item expands and collapses independently', async () => {
  const longText = '这是一段很长的对话正文，用来触发三行折叠。'.repeat(10)
  const toolText = '[tool] bash ' + 'x'.repeat(300)
  const board = await mountBoard(withSnapshot({}), {
    member: () => ({
      status: 200,
      body: memberPayload({
        transcript: {
          available: true,
          messages: [
            { seq: 1, role: 'user', text: longText },
            { seq: 2, role: 'assistant', text: 'ok' },
            { seq: 3, role: 'tool', text: toolText },
          ],
          truncated: false,
          totalEvents: 3,
          error: null,
        },
      }),
    }),
  })
  try {
    let tree = await board.render()
    findMemberNode(tree, 'impl-a').props.onClick()
    tree = await board.render()
    const itemsNow = () => findByClass(tree, 'atw-member-transcript-item')
    const textNow = (index) => findByClass(itemsNow()[index], 'atw-member-transcript-text')[0]
    assert.equal(itemsNow().length, 3, 'one row per message')
    assert.equal(itemsNow()[0].props.role, 'button', 'each transcript row is operable')
    assert.equal(itemsNow()[0].props.tabIndex, 0)
    assert.ok(!String(textNow(0).props.className).includes('--expanded'), 'rows start clamped')
    assert.equal(findByClass(tree, 'atw-member-transcript-toggle').length, 2, 'only the long bodies offer a toggle')
    assert.match(source, /\.atw-member-transcript-text\{[^}]*-webkit-line-clamp:3/, 'the three-line clamp still applies')

    itemsNow()[0].props.onClick()
    tree = await board.render()
    assert.ok(String(textNow(0).props.className).includes('atw-member-transcript-text--expanded'), 'clicking a row expands it')
    assert.ok(textOf(itemsNow()[0]).includes('k:member.transcriptCollapse'), 'the affordance flips to collapse')

    // A second row can expand at the same time (keyboard path).
    itemsNow()[2].props.onKeyDown({ key: 'Enter', preventDefault() {} })
    tree = await board.render()
    assert.ok(String(textNow(2).props.className).includes('--expanded'), 'Enter expands the focused row')
    const expandedTexts = findByClass(tree, 'atw-member-transcript-text').filter((element) => String(element.props.className).includes('--expanded'))
    assert.equal(expandedTexts.length, 2, 'multiple rows stay expanded together')

    itemsNow()[0].props.onClick()
    tree = await board.render()
    assert.ok(!String(textNow(0).props.className).includes('--expanded'), 'clicking again collapses only that row')
    assert.ok(String(textNow(2).props.className).includes('--expanded'), 'the other expanded row is untouched')
  } finally {
    board.dispose()
  }
})

test('docs/19 token usage: renders member rows, totals and the capture time', async () => {
  const capturedAt = '2026-11-02T15:04:05.000Z'
  const usage = {
    capturedAt,
    members: {
      'impl-a': { uncachedInputTokens: 1234, outputTokens: 567, cacheReadTokens: 89012, cacheWriteTokens: 0 },
      'rev-b': { uncachedInputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 45 },
    },
    totals: { uncachedInputTokens: 1234, outputTokens: 570, cacheReadTokens: 89012, cacheWriteTokens: 45 },
  }
  const board = await mountBoard(withSnapshot({ run: { usage } }))
  try {
    const tree = await board.render()
    assert.equal(findByClass(tree, 'atw-usage').length, 1, 'the usage panel renders')
    const text = textOf(findByClass(tree, 'atw-usage')[0])
    for (const needle of ['k:board.usage', 'k:board.usageCapturedAt', 'k:board.usageTotals', 'k:board.usageInput', 'k:board.usageOutput', 'k:board.usageCacheRead', 'k:board.usageCacheWrite']) {
      assert.ok(text.includes(needle), 'usage panel is missing ' + needle)
    }
    const stamp = new Date(capturedAt)
    const pad = (value) => (value < 10 ? '0' + value : String(value))
    const expectedTime = pad(stamp.getHours()) + ':' + pad(stamp.getMinutes()) + ':' + pad(stamp.getSeconds())
    assert.ok(text.includes(expectedTime), 'the local capture time is shown: ' + expectedTime)

    const lines = findByClass(tree, 'atw-usage-line')
    assert.equal(lines.length, 4, 'header + two members + totals')
    const cellsOf = (line) => findByClass(line, 'atw-usage-cell').map((cell) => textOf(cell))
    assert.deepEqual(cellsOf(lines[1]), ['1,234', '567', '89,012', '0'], 'impl-a tokens are grouped and zeroes still render')
    assert.deepEqual(cellsOf(lines[2]), ['0', '3', '0', '45'], 'zero inputs are not hidden')
    assert.deepEqual(cellsOf(lines[3]), ['1,234', '570', '89,012', '45'], 'the totals row sums are shown as captured')
    assert.ok(textOf(lines[0]).includes('k:board.usageInput'), 'the header labels the columns')
  } finally {
    board.dispose()
  }
})

test('docs/19 token usage: a null (uncaptured) usage degrades without inventing numbers', async () => {
  const board = await mountBoard(withSnapshot({ run: { usage: null } }))
  try {
    const tree = await board.render()
    assert.equal(findByClass(tree, 'atw-usage').length, 1, 'the usage panel still renders')
    const text = textOf(findByClass(tree, 'atw-usage')[0])
    assert.ok(text.includes('k:board.usageEmpty'), 'the degraded copy is shown')
    assert.ok(!text.includes('k:error.title'), 'a null usage does not crash the board')
    assert.equal(findByClass(tree, 'atw-usage-line').length, 0, 'no table rows are fabricated')
  } finally {
    board.dispose()
  }

  // Snapshots that predate the usage field behave the same way.
  const legacy = await mountBoard(V2_SNAPSHOT)
  try {
    const tree = await legacy.render()
    const text = textOf(findByClass(tree, 'atw-usage')[0])
    assert.ok(text.includes('k:board.usageEmpty'), 'a missing usage block degrades too')
  } finally {
    legacy.dispose()
  }
})

test('topology: work items align under their owner column and stay inside the canvas', async () => {
  const base = V2_SNAPSHOT.run.items[0]
  const members = [
    { name: 'impl-a', role: 'teammate', status: 'running', context: 'fresh' },
    { name: 'rev-b', role: 'teammate', status: 'running', context: 'fresh' },
  ]
  const item = (id, owner, wave) => ({
    ...base,
    id,
    wave,
    owner,
    subject: 'item ' + id,
    status: 'running',
    reviewers: [],
    reviewRequests: [],
    handoffs: [],
    thread: [],
    claim: null,
  })
  const board = await mountBoard(
    withSnapshot({
      team: { members },
      run: { items: [item('X1', 'impl-a', 1), item('X2', 'impl-a', 1), item('X3', 'rev-b', 2)] },
    }),
  )
  try {
    const tree = await board.render()
    const leftOf = (element) => Number.parseFloat(String(element.props?.style?.left ?? 'NaN'))
    const topOf = (element) => Number.parseFloat(String(element.props?.style?.top ?? 'NaN'))
    const memberNodes = findByClass(tree, 'atw-node--member')
    const itemNodes = findByClass(tree, 'atw-node--item')
    assert.equal(memberNodes.length, 2)
    assert.equal(itemNodes.length, 3)
    const memberX = {}
    for (const node of memberNodes) memberX[String(node.props?.title ?? '').split(' · ')[0]] = leftOf(node)
    const byId = {}
    for (const node of itemNodes) {
      const title = String(node.props?.title ?? '')
      byId[title.split(' · ')[0]] = node
    }
    // First item of each owner shares the owner's x; a second item stays in the
    // same column but moves to the second row band.
    assert.ok(Math.abs(leftOf(byId.X1) - memberX['impl-a']) < 0.2, 'X1 aligns under impl-a')
    assert.ok(Math.abs(leftOf(byId.X3) - memberX['rev-b']) < 0.2, 'X3 aligns under rev-b')
    assert.ok(Math.abs(leftOf(byId.X2) - memberX['impl-a']) < 4.1, 'a second owned item stays in the column band')
    assert.notEqual(topOf(byId.X1), topOf(byId.X2), 'the second item moves to the next row band')
    for (const node of [...memberNodes, ...itemNodes]) {
      const left = leftOf(node)
      assert.ok(left >= 3 && left <= 97, 'nodes stay inside the canvas (' + left + ')')
    }
    for (const node of itemNodes) {
      const width = Number.parseFloat(String(node.props?.style?.maxWidth ?? 'NaN'))
      assert.ok(width >= 10 && width <= 18, 'item ids keep at least 10% of the canvas width (' + width + ')')
    }
  } finally {
    board.dispose()
  }
})
