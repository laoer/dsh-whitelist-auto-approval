import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMatcher, tokenize } from '../matcher.js'

const BIN = new URL('./fixtures/bin/', import.meta.url).pathname

function makeBin() {
  mkdirSync(BIN, { recursive: true })
  // The symlink test below creates this entry; remove a leftover from a
  // previous run so the suite is idempotent.
  rmSync(join(BIN, 'lark-link'), { force: true })
  for (const name of ['lark-cli', 'other-cli']) {
    const file = join(BIN, name)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  return BIN
}

const bin = makeBin()

function matcher(rules, extra = {}) {
  const warnings = []
  const match = createMatcher(rules, {
    home: '/Users/tester',
    tmp: '/private/var/folders/fake',
    env: { PATH: `${bin}:/usr/bin:/bin` },
    onWarning: (message) => warnings.push(message),
    ...extra,
  })
  return { match, warnings }
}

const context = { workspaceRoot: '/Users/tester/project', workdir: '/Users/tester/project' }

test('tokenize: plain invocation', () => {
  assert.deepEqual(tokenize('lark-cli task +get-my-tasks'), ['lark-cli', 'task', '+get-my-tasks'])
  assert.deepEqual(tokenize('  lark-cli\t--json  '), ['lark-cli', '--json'])
})

test('tokenize: quoting keeps shell-inert characters', () => {
  assert.deepEqual(tokenize('lark-cli im +send --text "a; b"'), ['lark-cli', 'im', '+send', '--text', 'a; b'])
  assert.deepEqual(tokenize("lark-cli --json '{\"a\":1}'"), ['lark-cli', '--json', '{"a":1}'])
  assert.deepEqual(tokenize('lark-cli \\;literal'), ['lark-cli', ';literal'])
})

test('tokenize: composition and expansion are refused', () => {
  for (const command of [
    'lark-cli; rm -rf ~',
    'lark-cli && rm -rf ~',
    'lark-cli | sh',
    'lark-cli > /tmp/out',
    'lark-cli < /etc/passwd',
    'lark-cli $(id)',
    'lark-cli `id`',
    'lark-cli (id)',
    'lark-cli {a,b}',
    'lark-cli\rm -rf ~',
    'lark-cli\nrm -rf ~',
    'lark-cli "unterminated',
    'lark-cli --text "$HOME"',
    'lark-cli --text `id`',
    'lark-cli &',
  ]) {
    assert.equal(tokenize(command), undefined, command)
  }
})

test('tokenize: single-quoted $ is literal', () => {
  assert.deepEqual(tokenize("lark-cli x '$HOME'"), ['lark-cli', 'x', '$HOME'])
})

test('match: allow-listed bare command gets the home grant', () => {
  const { match, warnings } = matcher([{ command: 'lark-cli' }])
  assert.deepEqual(warnings, [])
  assert.deepEqual(match('lark-cli task +get-my-tasks', context), {
    rule: 'lark-cli',
    grant: { mode: 'workspace-write', workspaceRoot: '/Users/tester' },
  })
})

test('match: an unattested command keeps the standing policy', () => {
  const { match } = matcher([{ command: 'lark-cli' }])
  assert.equal(match('rm -rf ~', context), undefined)
  assert.equal(match('other-cli --version', context), undefined)
})

test('match: path form of an allow-listed name is refused', () => {
  const { match } = matcher([{ command: 'lark-cli' }])
  assert.equal(match('./lark-cli task', context), undefined)
  assert.equal(match(`${bin}/lark-cli task`, context), undefined)
})

test('match: explicit absolute path form works', () => {
  const { match } = matcher([{ command: `${bin}/lark-cli` }])
  assert.equal(match(`${bin}/lark-cli task`, context)?.grant.mode, 'workspace-write')
  // PATH lookup of the same real file is the same trusted binary.
  assert.equal(match('lark-cli task', context)?.grant.mode, 'workspace-write')
  assert.equal(match('other-cli task', context), undefined)
})

test('match: a symlinked binary keeps matching by the invoked name', () => {
  writeFileSync(join(bin, 'real-lark.js'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'real-lark.js'), 0o755)
  symlinkSync(join(bin, 'real-lark.js'), join(bin, 'lark-link'))
  const { match } = matcher([{ command: 'lark-link' }])
  assert.notEqual(match('lark-link task', context), undefined)
})

test('match: a binary inside the workspace is refused (PATH shadowing)', () => {
  const { match } = matcher([{ command: 'lark-cli' }], { env: { PATH: `${bin}:/usr/bin` } })
  assert.equal(match('lark-cli task', { workspaceRoot: bin, workdir: bin }), undefined)
})

test('match: grant full and custom', () => {
  const full = matcher([{ command: 'lark-cli', grant: 'full' }]).match('lark-cli x', context)
  assert.deepEqual(full?.grant, { mode: 'danger-full-access' })

  const custom = matcher([{ command: 'lark-cli', grant: 'custom', root: '~/.lark-cli' }]).match('lark-cli x', context)
  assert.deepEqual(custom?.grant, { mode: 'workspace-write', workspaceRoot: '/Users/tester/.lark-cli' })
})

test('match: deny filters cancel the grant', () => {
  const { match } = matcher([{ command: 'lark-cli', deny: ['\\bupdate\\b'] }])
  assert.equal(match('lark-cli update', context), undefined)
  assert.notEqual(match('lark-cli task +get-my-tasks', context), undefined)
})

test('match: allow filters require a hit', () => {
  const { match } = matcher([{ command: 'lark-cli', allow: ['^(?:\\S+\\s+){1}task\\b'] }])
  assert.notEqual(match('lark-cli task +get-my-tasks', context), undefined)
  assert.equal(match('lark-cli im +send', context), undefined)
})

test('match: invalid config never widens access', () => {
  const invalidRegex = matcher([{ command: 'lark-cli', deny: ['('] }])
  assert.equal(invalidRegex.match('lark-cli x', context), undefined)
  assert.equal(invalidRegex.warnings.length, 1)

  const unknownGrant = matcher([{ command: 'lark-cli', grant: 'sudo' }])
  assert.equal(unknownGrant.match('lark-cli x', context), undefined)
  assert.equal(unknownGrant.warnings.length, 1)

  const noCommand = matcher([{ grant: 'home' }])
  assert.equal(noCommand.match('lark-cli x', context), undefined)
  assert.equal(noCommand.warnings.length, 1)

  const relativePath = matcher([{ command: 'bin/lark-cli' }])
  assert.equal(relativePath.match('bin/lark-cli x', context), undefined)
  assert.equal(relativePath.warnings.length, 1)
})

test('match: an unresolvable rule warns at build time, and extraPath can fix resolution', () => {
  const missing = matcher([{ command: 'not-installed-cli' }])
  assert.equal(missing.warnings.length, 1)
  assert.match(missing.warnings[0], /not on this PATH/)

  const withExtra = createMatcher([{ command: 'lark-cli' }], {
    home: '/Users/tester',
    tmp: '/private/var/folders/fake',
    env: { PATH: '/usr/bin:/bin' },
    extraPath: [bin],
    onWarning: () => {},
  })
  assert.notEqual(withExtra('lark-cli x', context), undefined)
})
