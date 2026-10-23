import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const BIN = new URL('./fixtures/bin-exec/', import.meta.url).pathname

function makeBin() {
  mkdirSync(BIN, { recursive: true })
  for (const name of ['lark-cli']) {
    const file = join(BIN, name)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
}

makeBin()

/** Minimal stand-in for the Cordis context the plugin decorates. */
function harness() {
  const original = function resolve(request) {
    return {
      command: request.command,
      workdir: '/work',
      sandboxPolicy: request.sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: '/work' },
    }
  }
  const shell = { resolve: original }
  const disposers = []
  const logs = []
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  }
  const ctx = {
    shell,
    logger,
    // Mirrors the shipped `ctx.inject(deps, (scope) => ...)` form.
    inject: (_deps, callback) => {
      callback({
        shell,
        logger,
        effect: (effect) => {
          disposers.push(effect())
        },
      })
    },
  }
  return { ctx, shell, original, logs, dispose: () => disposers.forEach((dispose) => dispose()) }
}

const policy = { mode: 'workspace-write', workspaceRoot: '/work', sessionId: 's1' }

test('apply: decorates resolve for an allow-listed command', () => {
  const { ctx, shell, logs } = harness()
  apply(ctx, { extraPath: [BIN], rules: [{ command: 'lark-cli', grant: 'home' }] })

  const spec = shell.resolve({ command: 'lark-cli task +get-my-tasks', sandboxPolicy: policy })
  assert.deepEqual(spec.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: homedir(), sessionId: 's1' })
  assert.equal(logs.filter(([level]) => level === 'info').length, 1)
})

test('apply: leaves other commands, full access, and read-only alone', () => {
  const { ctx, shell } = harness()
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })

  const other = shell.resolve({ command: 'touch /etc/x', sandboxPolicy: policy })
  assert.deepEqual(other.sandboxPolicy, policy)

  const full = shell.resolve({ command: 'lark-cli x', sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/work' } })
  assert.equal(full.sandboxPolicy.mode, 'danger-full-access')

  const readOnly = shell.resolve({ command: 'lark-cli x', sandboxPolicy: { mode: 'read-only', workspaceRoot: '/work' } })
  assert.equal(readOnly.sandboxPolicy.mode, 'read-only')
})

test('apply: disposal restores the original resolve', () => {
  const { ctx, shell, original, dispose } = harness()
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  assert.notEqual(shell.resolve, original)
  dispose()
  assert.equal(shell.resolve, original)
})

test('apply: a reload flattens the chain instead of stacking layers', () => {
  const { ctx, shell, original } = harness()
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  const first = shell.resolve
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  const second = shell.resolve
  assert.notEqual(second, first)
  assert.equal(second[Symbol.for('dsh-whitelist-auto-approval.original')], original)

  // Double application is idempotent: one grant, not two rewrites.
  const spec = shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy })
  assert.deepEqual(spec.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: homedir(), sessionId: 's1' })
})

test('apply: no rules means no grants', () => {
  const { ctx, shell } = harness()
  apply(ctx, {})
  assert.deepEqual(shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy, policy)
})

test('apply: volatile rules update without re-applying the plugin', () => {
  const { ctx, shell } = harness()
  let source = [{ command: 'lark-cli', grant: 'home' }]
  apply(ctx, { extraPath: [BIN], rules: { get: () => source } })
  const decorated = shell.resolve

  assert.deepEqual(shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: homedir(),
    sessionId: 's1',
  })

  // The settings page replaces the value inside the same volatile reference.
  source = []
  assert.deepEqual(shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy, policy)

  source = [{ command: 'lark-cli', grant: 'custom', root: '/work/only' }]
  assert.deepEqual(shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work/only',
    sessionId: 's1',
  })

  // Same decorator generation throughout: only the compiled rules changed.
  assert.equal(shell.resolve, decorated)
})
