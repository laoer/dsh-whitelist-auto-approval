import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const react = {
  createElement: () => null,
  Fragment: {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useReducer: (reducer, initial) => [initial, () => {}],
  useRef: (value) => ({ current: value }),
}

let api

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      assert.equal(definition.id, 'dsh-whitelist-auto-approval')
      api = definition.factory((id) => {
        if (id === 'react') return react
        throw new Error(`unexpected client require: ${id}`)
      })
    },
  },
}

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)

const { __test: helpers } = api
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

function codes(problems) {
  return problems.map((problem) => problem.code)
}

test('client: the UI key matches the package name and patch row id', () => {
  assert.equal(helpers.UI_KEY, `${pkg.name}#bash-sandbox-auto-approval`)
  assert.equal(helpers.PACKAGE, pkg.name)
  assert.equal(helpers.ROW_ID, 'bash-sandbox-auto-approval')
  assert.match(patch, /id:\s*bash-sandbox-auto-approval/)
})

test('client: normalizeRules tolerates missing and malformed entries', () => {
  assert.deepEqual(helpers.normalizeRules(undefined), [])
  assert.deepEqual(helpers.normalizeRules('nope'), [])

  const [notObject] = helpers.normalizeRules([null])
  assert.equal(notObject.entryProblem, 'notObject')

  const [badShape] = helpers.normalizeRules([{ command: 'gh', deny: 'not-an-array' }])
  assert.equal(badShape.entryProblem, 'badShape')
  assert.equal(badShape.deny, '')

  const [loaded] = helpers.normalizeRules([
    { name: 'GitHub', command: 'gh', grant: 'home', deny: ['a', 'b'], allow: [] },
  ])
  assert.equal(loaded.command, 'gh')
  assert.equal(loaded.name, 'GitHub')
  assert.equal(loaded.grant, 'home')
  assert.equal(loaded.deny, 'a\nb')
  assert.equal(loaded.entryProblem, undefined)
})

test('client: validateRule covers the fields the Host matcher cares about', () => {
  const rule = (overrides) => ({ ...helpers.fromRule({ command: 'gh', grant: 'home' }), ...overrides })

  assert.deepEqual(codes(helpers.validateRule(helpers.fromRule({ command: 'gh', grant: 'home' }), 0, [])), [])
  assert.deepEqual(codes(helpers.validateRule(helpers.fromRule({}), 0, [])), ['commandRequired'])
  assert.deepEqual(codes(helpers.validateRule(rule({ command: 'a b' }), 0, [])), ['commandSpace'])
  assert.deepEqual(codes(helpers.validateRule(rule({ command: './gh' }), 0, [])), ['commandPath'])
  assert.deepEqual(codes(helpers.validateRule(rule({ command: '/opt/gh' }), 0, [])), [])
  assert.deepEqual(codes(helpers.validateRule(rule({ command: '~/bin/gh' }), 0, [])), [])

  assert.deepEqual(codes(helpers.validateRule(rule({ grant: 'custom', root: '' }), 0, [])), ['rootRequired'])
  assert.deepEqual(codes(helpers.validateRule(rule({ grant: 'custom', root: 'bin' }), 0, [])), ['rootInvalid'])
  assert.deepEqual(codes(helpers.validateRule(rule({ grant: 'custom', root: '~/.gh' }), 0, [])), [])
  assert.deepEqual(codes(helpers.validateRule(rule({ grant: 'bogus' }), 0, [])), ['grantInvalid'])

  assert.deepEqual(codes(helpers.validateRule(rule({ deny: '(' }), 0, [])), ['denyInvalid'])
  assert.deepEqual(codes(helpers.validateRule(rule({ allow: '[a' }), 0, [])), ['allowInvalid'])

  const first = helpers.fromRule({ command: 'gh', grant: 'home' })
  const second = helpers.fromRule({ command: 'gh', grant: 'home' })
  assert.deepEqual(codes(helpers.validateRule(second, 1, [first, second])), ['duplicate'])

  assert.deepEqual(codes(helpers.validateRule({ ...rule({ grant: 'full' }), fullAck: false }, 0, [])), ['fullAck'])
  assert.deepEqual(codes(helpers.validateRule({ ...rule({ grant: 'full' }), fullAck: true }, 0, [])), [])
})

test('client: toConfigRules writes only the matcher-facing fields', () => {
  const rules = helpers.normalizeRules([
    { command: ' gh ', name: '', grant: 'home', deny: [' a ', '', 'b'], allow: [] },
    { command: 'tool', name: 'Tool', grant: 'custom', root: ' ~/.tool ' },
    { command: 'danger', grant: 'full' },
  ])

  assert.deepEqual(helpers.toConfigRules(rules), [
    { command: 'gh', deny: ['a', 'b'] },
    { command: 'tool', name: 'Tool', grant: 'custom', root: '~/.tool' },
    { command: 'danger', grant: 'full' },
  ])
})

test('client: rulesEqual ignores ids but sees content changes', () => {
  const left = helpers.normalizeRules([{ command: 'gh', grant: 'home' }])
  const same = helpers.normalizeRules([{ command: 'gh', grant: 'home' }])
  const changed = helpers.normalizeRules([{ command: 'gh', grant: 'full' }])
  assert.equal(helpers.rulesEqual(left, same), true)
  assert.equal(helpers.rulesEqual(left, changed), false)
})

test('client: parseRegexLines keeps order and reports the first invalid pattern', () => {
  assert.deepEqual(helpers.parseRegexLines(' a \n\n b ').patterns, ['a', 'b'])
  assert.equal(helpers.parseRegexLines('a\n(').invalid, '(')
})

test('client: every visible string used by the bundle is translated in zh and en', () => {
  const used = new Set([...source.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]))
  used.add('addToList')
  used.add('applyRule')
  for (const key of used) {
    assert.equal(typeof helpers.dicts.zh[key], 'string', `zh is missing ${key}`)
    assert.equal(typeof helpers.dicts.en[key], 'string', `en is missing ${key}`)
  }
})

test('client: page, table and editor render without throwing', () => {
  const t = (key) => key
  const rules = helpers.normalizeRules([{ command: 'gh', grant: 'home' }])
  const problems = rules.map((rule, index) => helpers.validateRule(rule, index, rules))
  const form = {
    state: { status: 'ready', writable: true, revision: 1, value: { rules: [{ command: 'gh', grant: 'home' }] } },
    mutate: async () => true,
  }

  assert.doesNotThrow(() => helpers.RuleConfigView({ view: 'summary', t, locale: null }))
  assert.doesNotThrow(() => helpers.RuleConfigView({ view: 'page', form, t, locale: null }))
  assert.doesNotThrow(() => helpers.RuleConfigView({ view: 'page', form: undefined, t, locale: null }))
  assert.doesNotThrow(() => helpers.RuleTable({ rules, problems, t, disabled: false, onEdit() {}, onDelete() {} }))
  assert.doesNotThrow(() => helpers.RuleTable({ rules: [], problems: [], t, disabled: false, onEdit() {}, onDelete() {} }))

  const custom = helpers.fromRule({ command: 'tool', grant: 'custom', root: '~/.tool' })
  assert.doesNotThrow(() =>
    helpers.RuleEditor({ initial: custom, index: null, all: [custom], t, onSave() {}, onCancel() {} }),
  )
  const full = helpers.fromRule({ command: 'danger', grant: 'full' })
  assert.doesNotThrow(() =>
    helpers.RuleEditor({ initial: full, index: null, all: [full], t, onSave() {}, onCancel() {} }),
  )
  const invalid = { ...helpers.fromRule({}), fullAck: false }
  assert.doesNotThrow(() =>
    helpers.RuleEditor({ initial: invalid, index: null, all: [invalid], t, onSave() {}, onCancel() {} }),
  )
})

test('client: apply registers the Plugins cell and the Settings section', () => {
  let registered
  const cells = []
  const injected = []
  const disposers = []
  const fakeController = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: { rules: [] } }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  let requestedEntry
  const configForms = {
    get: (entryId) => {
      requestedEntry = entryId
      return fakeController
    },
  }
  const ctx = {
    effect: (callback) => {
      disposers.push(callback())
    },
    locale: {
      register: (namespace, dictionaries) => {
        registered = { namespace, dictionaries }
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        return callback()
      },
      register: (options, component) => {
        cells.push({ options, component })
        return () => {}
      },
    },
  }
  ctx.inject = (_deps, callback) =>
    callback({
      configForms,
      effect: ctx.effect,
      slots: ctx.slots,
      locale: ctx.locale,
    })

  api.apply(ctx)

  assert.deepEqual(injected, ['plugins.row.config', 'settings.section'])
  const rowCell = cells.find((cell) => cell.options.name === 'plugins.row.config')
  const settingsCell = cells.find((cell) => cell.options.name === 'settings.section')
  assert.equal(rowCell.options.key, helpers.UI_KEY)
  assert.equal(typeof rowCell.component, 'function')

  assert.equal(settingsCell.options.id, 'auto-approval')
  assert.equal(settingsCell.options.order, 110)
  assert.equal(typeof settingsCell.options.label, 'function')
  assert.equal(settingsCell.options.label(), 'nav')
  assert.equal(typeof settingsCell.component, 'function')
  assert.equal(requestedEntry, helpers.ROW_ID)

  assert.equal(registered.namespace, 'dsh-whitelist-auto-approval.ui')
  assert.equal(typeof registered.dictionaries.zh.summary, 'string')
  assert.equal(typeof registered.dictionaries.en.summary, 'string')
  assert.equal(disposers.length, 2)

  assert.doesNotThrow(() =>
    helpers.SettingsSection({ controller: fakeController, t: (key) => key, locale: null }),
  )
})
