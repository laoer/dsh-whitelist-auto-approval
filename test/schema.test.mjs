import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, Schema } from '../schema.js'

test('schema: exposes a standard schemastery schema', () => {
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(typeof Config.toJSON, 'function')
  assert.equal(typeof Config['~standard'].validate, 'function')
})

test('schema: only rules is volatile', () => {
  assert.equal(Config.dict.rules.meta.volatile, true)
  assert.equal(Config.dict.audit.meta.volatile, undefined)
  assert.equal(Config.dict.upgradeFromReadOnly.meta.volatile, undefined)
  assert.equal(Config.dict.extraPath.meta.volatile, undefined)
  assert.equal(Config.dict.trace.meta.volatile, undefined)
})

test('schema: defaults keep the existing behavior', () => {
  const value = Config({})
  assert.equal(value.audit, true)
  assert.equal(value.upgradeFromReadOnly, false)
  assert.deepEqual(value.extraPath, [])
  assert.deepEqual(value.rules.get(), [])
})

test('schema: rules entries stay permissive for the matcher', () => {
  const value = Config({ rules: [{ command: 'lark-cli' }, null, 'nonsense'] })
  assert.deepEqual(value.rules.get(), [{ command: 'lark-cli' }, null, 'nonsense'])
})

test('schema: a non-array rules value is rejected', () => {
  assert.throws(() => Config({ rules: 'lark-cli' }), /rules/)
})

test('schema: volatile marker survives the settings toJSON round-trip', () => {
  const rebuilt = new Schema(Config.toJSON())
  assert.equal(rebuilt.dict.rules.meta.volatile, true)
  assert.equal(rebuilt.dict.rules.type, 'array')
  assert.equal(rebuilt.dict.rules.inner.type, 'any')
})

test('schema: an existing bundle config validates unchanged', () => {
  const value = Config({
    audit: true,
    upgradeFromReadOnly: false,
    rules: [
      { name: 'lark-cli', command: 'lark-cli', grant: 'home' },
      { name: 'gh', command: 'gh', grant: 'home' },
    ],
  })
  assert.equal(value.rules.get().length, 2)
  assert.equal(value.rules.get()[0].command, 'lark-cli')
})
