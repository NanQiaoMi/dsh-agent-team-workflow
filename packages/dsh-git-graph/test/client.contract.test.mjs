import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientPath = resolve(__dirname, '../client.js')
const clientSource = readFileSync(clientPath, 'utf8')

test('client.js source conforms to zero-external-require sandbox rules', () => {
  // Must match window.__ModuleLoader__.load
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(/)

  // Must only require('react')
  const requireMatches = [...clientSource.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
  assert.ok(requireMatches.length > 0, 'must have at least one require')
  for (const match of requireMatches) {
    assert.equal(match[1], 'react', `forbidden require found: ${match[1]}`)
  }

  // Must not reference forbidden document.body mutations or iframes
  assert.doesNotMatch(clientSource, /document\.body\.appendChild/)
  assert.doesNotMatch(clientSource, /<iframe/)
})

test('client factory executes and registers slots and locale dictionaries', () => {
  let loadedModule = null
  const mockWindow = {
    __ModuleLoader__: {
      load(mod) {
        loadedModule = mod
      },
    },
  }

  // Execute in VM with mock React
  const mockReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  }

  const context = vm.createContext({
    window: mockWindow,
    navigator: { clipboard: { writeText: async () => {} } },
    document: { hidden: false },
    setInterval: () => 1,
    clearInterval: () => {},
  })

  vm.runInContext(clientSource, context)

  assert.ok(loadedModule, 'ModuleLoader.load was called')
  assert.equal(loadedModule.id, '@local/dsh-git-graph')
  assert.equal(typeof loadedModule.factory, 'function')

  const requireMock = (id) => {
    if (id === 'react') return mockReact
    throw new Error(`Unexpected require: ${id}`)
  }

  const plugin = loadedModule.factory(requireMock)
  assert.ok(plugin)
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])

  // Mock Cordis Client context
  const registeredLocales = new Map()
  const injectedSlots = new Map()

  const mockClientCtx = {
    locale: {
      register(ns, dicts) {
        registeredLocales.set(ns, dicts)
      },
      bind(ns) {
        return (key) => key
      },
    },
    slots: {
      inject(slotName, callback) {
        injectedSlots.set(slotName, callback)
      },
      register(options, component) {
        return { options, component }
      },
    },
  }

  plugin.apply(mockClientCtx)

  // Verify locale dictionary parity
  assert.ok(registeredLocales.has('dsh-git-graph'))
  const { zh, en } = registeredLocales.get('dsh-git-graph')
  assert.ok(zh && en)
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en dictionary keys must have 100% parity')

  // Verify conversation.input.dock registration
  assert.ok(injectedSlots.has('conversation.input.dock'))
  const dockReg = injectedSlots.get('conversation.input.dock')()
  assert.equal(dockReg.options.name, 'conversation.input.dock')
  assert.equal(dockReg.options.id, 'dsh-git-dock')
  assert.equal(dockReg.options.order, 15)

  // Verify conversation.view registration
  assert.ok(injectedSlots.has('conversation.view'))
  const viewReg = injectedSlots.get('conversation.view')()
  assert.equal(viewReg.options.name, 'conversation.view')
  assert.equal(viewReg.options.id, 'dsh-git-graph')
  assert.equal(viewReg.options.order, 25)
  assert.equal(typeof viewReg.options.label, 'function')

  // Verify component rendering safety when snapshot is null / offline
  const GitGraphView = viewReg.component
  assert.doesNotThrow(() => {
    GitGraphView({ sessionId: 'test', t: (k) => k })
  }, 'GitGraphView must never throw when snapshot is null')

  const GitDock = dockReg.component
  assert.doesNotThrow(() => {
    GitDock({ sessionId: 'test', t: (k) => k })
  }, 'GitDock must never throw when snapshot is null')
})
