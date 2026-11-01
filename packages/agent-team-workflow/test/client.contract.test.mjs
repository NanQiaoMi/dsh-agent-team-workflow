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
 *      literals, forbidden constructs, no hardcoded colours, dictionary parity;
 *   2. behavioural — the exact `conversation.view` registration shape, the
 *      locale namespace/dictionaries, and a render smoke test of the empty
 *      state (which is where every optional snapshot field is exercised first).
 *
 * Run: node --test test/client.contract.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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
function createReactStub() {
  const required = []
  const react = {
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
