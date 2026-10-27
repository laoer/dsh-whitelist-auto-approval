import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, resolveGrantShape } from '../index.js'

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
function harness(options = {}) {
  const original = function resolve(request) {
    return {
      command: request.command,
      workdir: '/work',
      sandboxPolicy: request.sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: '/work' },
    }
  }
  const shell = { resolve: original }
  const sandbox = options.sandbox
  const disposers = []
  const logs = []
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  }
  // One registered prompt section per live `apply`, mirroring the registry's
  // name-keyed insertion and its effect disposer.
  const sections = []
  const systemPrompt =
    options.systemPrompt === null
      ? undefined
      : {
          getSectionOrder: (name) => (name === 'TOOL_BASH' ? 1000 : undefined),
          section: (section) => {
            sections.push(section)
            return () => {
              const index = sections.indexOf(section)
              if (index >= 0) sections.splice(index, 1)
            }
          },
          ...options.systemPrompt,
        }
  const ctx = {
    shell,
    sandbox,
    logger,
    // Mirrors the shipped `ctx.inject(deps, (scope) => ...)` form.
    inject: (_deps, callback) => {
      callback({
        shell,
        sandbox,
        logger,
        systemPrompt,
        effect: (effect) => {
          disposers.push(effect())
        },
      })
    },
  }
  return {
    ctx,
    shell,
    sandbox,
    sections,
    original,
    logs,
    dispose: () => disposers.forEach((dispose) => dispose()),
  }
}

/** A sandbox provider whose confine() returns the shipped Seatbelt argv shape. */
function seatbeltSandbox() {
  const original = async (argv) => ({
    argv: ['sandbox-exec', '-p', '(version 1)(allow default)(deny file-write*)', '--', 'bash', '-c', String(argv?.[2] ?? 'x')],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
  })
  return { confine: original }
}

const policy = { mode: 'workspace-write', workspaceRoot: '/work', sessionId: 's1' }

test('apply: decorates resolve for an allow-listed command', () => {
  const { ctx, shell, logs } = harness()
  apply(ctx, { extraPath: [BIN], rules: [{ command: 'lark-cli', grant: 'home' }] })

  const spec = shell.resolve({ command: 'lark-cli task +get-my-tasks', sandboxPolicy: policy })
  // POSIX grants are additive even before an overlay reports ready: the
  // workspace root stays and the rule's roots are appended for the provider.
  assert.deepEqual(spec.sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: [homedir()],
  })
  assert.equal(logs.filter(([level]) => level === 'info').length, 1)
})

test('apply: a leading cd prefix still gets the grant', () => {
  const { ctx, shell, logs } = harness()
  apply(ctx, { extraPath: [BIN], rules: [{ command: 'lark-cli', grant: 'home' }] })

  const spec = shell.resolve({
    command: 'cd /home/xiuyuan/project/shchest-web-hospital && lark-cli wiki +move --obj-type docx',
    sandboxPolicy: policy,
  })
  assert.deepEqual(spec.sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: [homedir()],
  })
  assert.equal(logs.filter(([level]) => level === 'info').length, 1)
})

test('apply: allowCdPrefix false leaves the cd-prefixed command alone', () => {
  const { ctx, shell } = harness()
  apply(ctx, { extraPath: [BIN], allowCdPrefix: false, rules: [{ command: 'lark-cli', grant: 'home' }] })

  const spec = shell.resolve({ command: 'cd /work && lark-cli wiki +move', sandboxPolicy: policy })
  assert.deepEqual(spec.sandboxPolicy, policy)
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
  assert.deepEqual(spec.sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: [homedir()],
  })
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
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: [homedir()],
  })

  // The settings page replaces the value inside the same volatile reference.
  source = []
  assert.deepEqual(shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy, policy)

  source = [{ command: 'lark-cli', grant: 'custom', root: '/work/only' }]
  assert.deepEqual(shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: ['/work/only'],
  })

  // Same decorator generation throughout: only the compiled rules changed.
  assert.equal(shell.resolve, decorated)
})

test('overlay: the home grant keeps the workspace and adds $HOME as an extra root', async () => {
  const { ctx, shell, sandbox } = harness({ sandbox: seatbeltSandbox() })
  apply(ctx, { extraPath: [BIN], rules: [{ command: 'lark-cli', grant: 'home' }] })

  const spec = shell.resolve({ command: 'lark-cli task +get-my-tasks', sandboxPolicy: policy })
  assert.deepEqual(spec.sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: [homedir()],
  })

  const confined = await sandbox.confine([], spec.sandboxPolicy)
  assert.equal(confined.enforcement, 'full')
  assert.equal(confined.argv[0], 'sandbox-exec')
  assert.ok(confined.argv[2].includes(`(subpath "${homedir()}")`), confined.argv[2])
})

test('overlay: disposal restores the original confine', () => {
  const sandbox = seatbeltSandbox()
  const original = sandbox.confine
  const { ctx, dispose } = harness({ sandbox })
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  assert.notEqual(sandbox.confine, original)
  dispose()
  assert.equal(sandbox.confine, original)
})

test('overlay: a reload flattens the confine chain', () => {
  const sandbox = seatbeltSandbox()
  const original = sandbox.confine
  const { ctx } = harness({ sandbox })
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  const first = sandbox.confine
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  const second = sandbox.confine
  assert.notEqual(second, first)
  assert.equal(second[Symbol.for('dsh-whitelist-auto-approval.sandbox-original')], original)
})

test('overlay: an unrecognized runner keeps the grant additive and warns once', async () => {
  const sandbox = {
    confine: async () => ({ argv: ['mystery-sandbox', '--', 'bash'], enforcement: 'full' }),
  }
  const { ctx, shell, logs } = harness({ sandbox })
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })

  const first = shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy })
  assert.deepEqual(first.sandboxPolicy.extraWritableRoots, [homedir()])
  assert.equal(first.sandboxPolicy.workspaceRoot, '/work')

  // Running the call reveals a runner the overlay cannot extend.
  await sandbox.confine([], first.sandboxPolicy)
  assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('cannot be extended')))

  // The grant still keeps the workspace and still carries the extra root. A
  // replacement would silently drop the workspace, so it must never happen on
  // POSIX — the worst case stays "the extra root is inert".
  for (let i = 0; i < 3; i += 1) {
    const spec = shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy })
    assert.deepEqual(spec.sandboxPolicy, {
      mode: 'workspace-write',
      workspaceRoot: '/work',
      sessionId: 's1',
      extraWritableRoots: [homedir()],
    })
  }

  const warnings = logs.filter(([level, message]) => level === 'warn' && message.includes('writable-root overlay is not installed'))
  assert.equal(warnings.length, 1)
  // The first grant happened while the overlay was still optimistic, so only
  // the three after the runner was proven unextendable carry the marker.
  const grants = logs.filter(([level, message]) => level === 'info' && message.includes('root overlay inactive'))
  assert.equal(grants.length, 3)
})

test('overlay: a custom grant adds its root and keeps the workspace', () => {
  const { ctx, shell } = harness({ sandbox: seatbeltSandbox() })
  apply(ctx, { rules: [{ command: 'lark-cli', grant: 'custom', root: '/work/only' }] })

  const spec = shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy })
  assert.deepEqual(spec.sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/work',
    sessionId: 's1',
    extraWritableRoots: ['/work/only'],
  })
})

test('overlay: several roots from one rule are appended together', () => {
  const { ctx, shell } = harness({ sandbox: seatbeltSandbox() })
  apply(ctx, {
    rules: [{ command: 'lark-cli', roots: ['/work/state', '/work/cache'], shape: 'strict' }],
  })

  const spec = shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy })
  assert.deepEqual(spec.sandboxPolicy.extraWritableRoots, ['/work/state', '/work/cache'])
  assert.equal(spec.sandboxPolicy.workspaceRoot, '/work')
})

test('overlay: without the overlay a multi-root rule stays additive', async () => {
  const sandbox = { confine: async () => ({ argv: ['mystery-sandbox', '--', 'bash'], enforcement: 'full' }) }
  const { ctx, shell, logs } = harness({ sandbox })
  apply(ctx, { rules: [{ command: 'lark-cli', roots: ['/work/state', '/work/cache'] }] })

  // The first call is still optimistic; running it reveals a runner we cannot
  // extend, which flips the overlay to "not ready".
  await sandbox.confine([], shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy)

  for (let i = 0; i < 3; i += 1) {
    const spec = shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy })
    assert.deepEqual(spec.sandboxPolicy, {
      mode: 'workspace-write',
      workspaceRoot: '/work',
      sessionId: 's1',
      extraWritableRoots: ['/work/state', '/work/cache'],
    })
  }

  const warnings = logs.filter(([level, message]) => level === 'warn' && message.includes('writable-root overlay is not installed'))
  assert.equal(warnings.length, 1)
})

test('prompt: the live rules are announced right after tool:bash', () => {
  const { ctx, sections, dispose } = harness()
  apply(ctx, {
    extraPath: [BIN],
    rules: [
      { command: 'lark-cli', grant: 'home' },
      { command: 'gh', name: 'gh-cli', grant: 'home' },
    ],
  })

  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.name, 'tool:bash:auto-approval')
  assert.equal(section.order, 1002)
  // Rule labels are user data, so the section must never be interpolated.
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')

  const text = section.text({})
  assert.match(text, /lark-cli/)
  assert.match(text, /gh-cli/)
  assert.match(text, /2>&1/)
  assert.match(text, /`tail`/)
  assert.match(text, /approval prompt/)

  // The registration is owned by this plugin's effect, so unloading removes it.
  dispose()
  assert.equal(sections.length, 0)
})

test('prompt: the hint follows the volatile rules and is empty without any', () => {
  const { ctx, sections } = harness()
  let source = []
  apply(ctx, { extraPath: [BIN], rules: { get: () => source } })
  assert.equal(sections[0].text({}), '')

  source = [{ command: 'lark-cli', grant: 'home' }]
  assert.match(sections[0].text({}), /lark-cli/)
  assert.equal(sections.length, 1)
})

test('prompt: disabling the hint, a missing service, and a failing registration stay contained', () => {
  const off = harness()
  apply(off.ctx, { promptHint: false, rules: [{ command: 'lark-cli', grant: 'home' }] })
  assert.equal(off.sections.length, 0)
  // Disabling the hint must not touch the actual grant.
  assert.deepEqual(off.shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy.extraWritableRoots, [
    homedir(),
  ])

  const missing = harness({ systemPrompt: null })
  apply(missing.ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  assert.equal(missing.sections.length, 0)
  assert.deepEqual(missing.shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy.extraWritableRoots, [
    homedir(),
  ])

  const broken = harness({
    systemPrompt: {
      section: () => {
        throw new Error('duplicate section')
      },
    },
  })
  apply(broken.ctx, { rules: [{ command: 'lark-cli', grant: 'home' }] })
  assert.equal(broken.logs.some(([level, message]) => level === 'warn' && /prompt section skipped/.test(message)), true)
  assert.deepEqual(broken.shell.resolve({ command: 'lark-cli x', sandboxPolicy: policy }).sandboxPolicy.extraWritableRoots, [
    homedir(),
  ])
})

test('prompt: any-shaped rules are announced as shape-independent', () => {
  const { ctx, sections } = harness()
  apply(ctx, {
    extraPath: [BIN],
    rules: [
      { command: 'lark-cli', roots: ['~/.lark-cli'], shape: 'any' },
      { command: 'gh', grant: 'home' },
    ],
  })

  const text = sections[0].text({})
  assert.match(text, /whatever the shell syntax/)
  assert.match(text, /lark-cli/)
  assert.match(text, /gh/)
})

test('grant shape: POSIX additive, Windows replace, overlay-free POSIX marked', () => {
  const roots = { kind: 'roots', mode: 'workspace-write', roots: ['/a', '/b'] }

  assert.deepEqual(resolveGrantShape(roots, { overlayReady: true, platform: 'darwin' }), {
    additive: true,
    overlayMissing: false,
    target: '+/a +/b',
  })
  assert.deepEqual(resolveGrantShape(roots, { overlayReady: false, platform: 'linux' }), {
    additive: true,
    overlayMissing: true,
    target: '+/a +/b (root overlay inactive)',
  })
  assert.deepEqual(resolveGrantShape(roots, { overlayReady: true, platform: 'win32' }), {
    additive: false,
    overlayMissing: false,
    target: '/a',
  })

  const full = { kind: 'full', mode: 'danger-full-access', roots: [] }
  assert.deepEqual(resolveGrantShape(full, { overlayReady: true, platform: 'darwin' }), {
    additive: false,
    overlayMissing: false,
    target: 'danger-full-access',
  })
})
