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
async function mountBoard(snapshot) {
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
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => snapshot })
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
  return { ...restored, render, copyKeys, keydown }
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
