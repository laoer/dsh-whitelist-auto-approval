import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMatcher, parsePipeline, splitCdPrefix, tokenize } from '../matcher.js'

const BIN = new URL('./fixtures/bin/', import.meta.url).pathname
const FILTERS = new URL('./fixtures/filters/', import.meta.url).pathname

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

/**
 * A `tail` the test can place on PATH. It lives outside the fake workspace, so
 * the same fixture is accepted from one context and refused from another.
 */
function makeFilters() {
  mkdirSync(FILTERS, { recursive: true })
  const file = join(FILTERS, 'tail')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return FILTERS
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

test('splitCdPrefix: one leading cd is split off', () => {
  assert.deepEqual(splitCdPrefix('cd /srv/app && lark-cli wiki +move --obj-type docx'), {
    target: '/srv/app',
    rest: ' lark-cli wiki +move --obj-type docx',
  })
  assert.deepEqual(splitCdPrefix('  cd\t~/repo&&lark-cli x'), { target: '~/repo', rest: 'lark-cli x' })
  // An `&&` inside the target belongs to the argument, not to the composition.
  assert.deepEqual(splitCdPrefix('cd "a && b" && lark-cli x'), { target: 'a && b', rest: ' lark-cli x' })
})

test('splitCdPrefix: anything but cd <one path> && is refused', () => {
  for (const command of [
    'cd /x',
    'cd',
    'cdx /x && lark-cli',
    'cd - && lark-cli',
    'cd -P /x && lark-cli',
    'cd a b && lark-cli',
    'lark-cli && cd /x',
    'cd /x; lark-cli',
    'cd "unterminated && lark-cli',
    'cd /x &&',
  ]) {
    assert.equal(splitCdPrefix(command), undefined, command)
  }
})

test('match: a cd prefix is the same request as the tool workdir', () => {
  const { match } = matcher([{ command: 'lark-cli' }])
  assert.deepEqual(match('cd /home/xiuyuan/project/shchest-web-hospital && lark-cli wiki +move --obj-type docx', context), {
    rule: 'lark-cli',
    grant: { kind: 'home', mode: 'workspace-write', roots: ['/Users/tester'] },
  })
  assert.notEqual(match('cd ~/repo && lark-cli task +get-my-tasks', context), undefined)
  assert.notEqual(match('cd ../sibling && lark-cli task', context), undefined)
})

test('match: a cd prefix does not unlock a second command', () => {
  const { match } = matcher([{ command: 'lark-cli' }])
  for (const command of [
    'cd /srv && lark-cli x; rm -rf ~',
    'cd /srv && lark-cli x | tee out',
    'cd /srv && cd /other && lark-cli x',
    'cd /srv && lark-cli x > /tmp/out',
    'cd /srv && other-cli x',
    'cd /srv && ./lark-cli x',
    'cd /srv && rm -rf ~',
    'cd /srv && lark-cli x && rm -rf ~',
  ]) {
    assert.equal(match(command, context), undefined, command)
  }
})

test('match: allowCdPrefix false keeps the strict reading', () => {
  const { match } = matcher([{ command: 'lark-cli' }], { allowCdPrefix: false })
  assert.equal(match('cd /srv && lark-cli x', context), undefined)
  assert.notEqual(match('lark-cli x', context), undefined)
})

test('match: deny and allow filters still see the whole command with a cd prefix', () => {
  const { match } = matcher([{ command: 'lark-cli', deny: ['/srv'] }])
  assert.equal(match('cd /srv && lark-cli wiki +move', context), undefined)
  assert.notEqual(match('cd /other && lark-cli wiki +move', context), undefined)
})

test('match: allow-listed bare command gets the home grant', () => {
  const { match, warnings } = matcher([{ command: 'lark-cli' }])
  assert.deepEqual(warnings, [])
  assert.deepEqual(match('lark-cli task +get-my-tasks', context), {
    rule: 'lark-cli',
    grant: { kind: 'home', mode: 'workspace-write', roots: ['/Users/tester'] },
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
  assert.deepEqual(full?.grant, { kind: 'full', mode: 'danger-full-access', roots: [] })

  const custom = matcher([{ command: 'lark-cli', grant: 'custom', root: '~/.lark-cli' }]).match('lark-cli x', context)
  assert.deepEqual(custom?.grant, { kind: 'custom', mode: 'workspace-write', roots: ['/Users/tester/.lark-cli'] })
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

test('parsePipeline: stages, pipes, and redirects are described instead of judged', () => {
  assert.deepEqual(parsePipeline('lark-cli docs +update 2>&1 | tail -12'), {
    stages: [
      { argv: ['lark-cli', 'docs', '+update'], redirects: [{ fd: 2, op: '>', dup: true, target: '1' }] },
      { argv: ['tail', '-12'], redirects: [] },
    ],
  })
  assert.deepEqual(parsePipeline('lark-cli x >/dev/null'), {
    stages: [{ argv: ['lark-cli', 'x'], redirects: [{ fd: 1, op: '>', dup: false, target: '/dev/null' }] }],
  })
  // A separated digit is an argument, not a descriptor.
  assert.deepEqual(parsePipeline('lark-cli x 2 > out')?.stages[0].redirects, [{ fd: 1, op: '>', dup: false, target: 'out' }])
  // Still not representable from the string alone.
  for (const command of ['lark-cli x; y', 'lark-cli x && y', 'lark-cli x >>&1', 'lark-cli x <<EOF', 'lark-cli x `id`', 'lark-cli x &> out']) {
    assert.equal(parsePipeline(command), undefined, command)
  }
})

test('tokenize: the strict reading does not learn the pipeline grammar', () => {
  assert.equal(tokenize('lark-cli x 2>&1'), undefined)
  assert.equal(tokenize('lark-cli x | tail -12'), undefined)
  assert.deepEqual(tokenize('lark-cli "a 2>&1 b"'), ['lark-cli', 'a 2>&1 b'])
})

test('match: write-neutral suffixes keep the grant', () => {
  const { match } = matcher([{ command: 'lark-cli' }])
  for (const command of [
    'lark-cli docs +update --doc D --as user 2>&1',
    'lark-cli docs +update --doc D --as user 2>&1 | tail -12',
    'lark-cli docs +update --doc D | head -n 20',
    'lark-cli task +get-my-tasks | wc -l',
    'lark-cli task +get-my-tasks | tail --lines=5',
    'lark-cli task +get-my-tasks 2>&1|tail -12',
    'lark-cli task +get-my-tasks |& tail -3',
    'lark-cli task +get-my-tasks 2>/dev/null',
    'lark-cli task +get-my-tasks 1>&2',
    'lark-cli task +get-my-tasks >&-',
    'lark-cli task +get-my-tasks >> /dev/null 2>&1',
    'cd /home/xiuyuan/project/shchest-web-hospital && lark-cli docs +update --doc D --as user 2>&1 | tail -12',
  ]) {
    assert.notEqual(match(command, context), undefined, command)
  }
})

test('match: a suffix that can write, or run a second program, is still a non-match', () => {
  const { match } = matcher([{ command: 'lark-cli' }])
  for (const command of [
    'lark-cli x | tee out.log',
    'lark-cli x | sh',
    'lark-cli x | sed -i s/a/b/ f',
    'lark-cli x | awk "{print > \\"f\\"}"',
    'lark-cli x | tail -f out.log',
    'lark-cli x | tail out.log',
    'lark-cli x | lark-cli y',
    'lark-cli x > out.log',
    'lark-cli x >|out.log',
    'lark-cli x 2> out.log',
    'lark-cli x 2>&1 > out.log',
    'lark-cli x; echo done',
    'lark-cli x && echo done',
    'lark-cli x | tail $(echo 3)',
    'lark-cli x | tail -n 3 > out.log',
  ]) {
    assert.equal(match(command, context), undefined, command)
  }
})

test('match: filters get the same shadowing checks as the matched program', () => {
  const filters = makeFilters()
  const { match } = matcher([{ command: 'lark-cli' }], { env: { PATH: `${filters}:${bin}:/usr/bin:/bin` } })
  assert.notEqual(match('lark-cli x | tail -3', context), undefined)
  // The same filter resolved from the session workspace is a repository-supplied
  // binary, so the grant is refused even though the matched program is trusted.
  assert.equal(match('lark-cli x | tail -3', { workspaceRoot: filters, workdir: filters }), undefined)
})

test('match: deny filters still see the raw command with a pipeline', () => {
  const { match } = matcher([{ command: 'lark-cli', deny: ['\\|\\s*tail\\b'] }])
  assert.equal(match('lark-cli docs +update | tail -12', context), undefined)
  assert.notEqual(match('lark-cli docs +update 2>&1', context), undefined)
})

test('match: roots replaces the home grant with the listed directories', () => {
  const { match } = matcher([{ command: 'lark-cli', roots: ['~/.lark-cli', '/work/cache'] }])
  assert.deepEqual(match('lark-cli x', context)?.grant, {
    kind: 'roots',
    mode: 'workspace-write',
    roots: ['/Users/tester/.lark-cli', '/work/cache'],
  })
})

test('match: an invalid roots list drops the rule instead of widening it', () => {
  for (const roots of [['/'], ['relative/dir'], [], ['/ok', 7]]) {
    const { match, warnings } = matcher([{ command: 'lark-cli', roots }])
    assert.equal(match('lark-cli x', context), undefined, JSON.stringify(roots))
    assert.equal(warnings.length, 1, JSON.stringify(roots))
  }
})

test('match: an explicit roots list wins over grant and root', () => {
  const { match, warnings } = matcher([{ command: 'lark-cli', grant: 'custom', root: '/elsewhere', roots: ['~/.lark-cli'] }])
  assert.deepEqual(match('lark-cli x', context)?.grant.roots, ['/Users/tester/.lark-cli'])
  assert.match(warnings[0], /takes precedence/)
})

test('match: shape any accepts arbitrary shell syntax', () => {
  const { match } = matcher([{ command: 'lark-cli', roots: ['~/.lark-cli'], shape: 'any' }])
  for (const command of [
    'lark-cli docs +update --doc D | tee /tmp/out',
    'lark-cli x; echo done',
    'lark-cli x && lark-cli y',
    'for d in a b; do lark-cli x "$d"; done',
    'cd /repo && lark-cli x 2>&1 | head -3',
    'xargs -n1 lark-cli x',
    'LARK=1 lark-cli x',
  ]) {
    assert.notEqual(match(command, context), undefined, command)
  }
})

test('match: shape any still refuses a model-chosen path and unknown programs', () => {
  const { match } = matcher([{ command: 'lark-cli', roots: ['~/.lark-cli'], shape: 'any' }])
  for (const command of ['./lark-cli x', '/tmp/lark-cli x', '~/bin/lark-cli x', 'rm -rf ~', `bash -c 'lark-cli x'`]) {
    assert.equal(match(command, context), undefined, command)
  }
  // A name used as an ordinary argument counts as a mention (the grant is the
  // narrow root, so the cost is scoping, not permission).
  assert.notEqual(match('echo lark-cli', context), undefined)
  // Comments and redirect targets are not mentions.
  assert.equal(match('echo hi # lark-cli', context), undefined)
  assert.equal(match('echo hi > /tmp/lark-cli', context), undefined)
})

test('match: shape any is refused when the roots contain $HOME', () => {
  for (const rule of [
    { command: 'lark-cli', grant: 'home', shape: 'any' },
    { command: 'lark-cli', roots: ['/Users/tester'], shape: 'any' },
  ]) {
    const { match, warnings } = matcher([rule])
    assert.equal(match('lark-cli x', context), undefined)
    assert.equal(warnings.length, 1)
  }
  const { match } = matcher([{ command: 'lark-cli', grant: 'full', shape: 'any' }])
  assert.equal(match('lark-cli x | tee out', context)?.grant.mode, 'danger-full-access')
})

test('match: a later any-shaped rule can claim what a strict rule refused', () => {
  const { match } = matcher([
    { command: 'lark-cli', name: 'strict', roots: ['~/.a'] },
    { command: 'lark-cli', name: 'loose', roots: ['~/.b'], shape: 'any' },
  ])
  assert.equal(match('lark-cli x', context)?.rule, 'strict')
  assert.equal(match('lark-cli x | tee out', context)?.rule, 'loose')
})

test('match: shape any recognises a path-form rule by its declared path', () => {
  const { match } = matcher([{ command: `${bin}/lark-cli`, roots: ['~/.lark-cli'], shape: 'any' }])
  assert.notEqual(match(`${bin}/lark-cli x | tee /tmp/o`, context), undefined)
  assert.equal(match('lark-cli x | tee /tmp/o', context), undefined)
})

test('match: deny and allow filters still apply to any-shaped rules', () => {
  const { match } = matcher([{ command: 'lark-cli', roots: ['~/.lark-cli'], shape: 'any', deny: ['\\bapi\\b'] }])
  assert.equal(match('lark-cli api get | tee out', context), undefined)
  assert.notEqual(match('lark-cli task', context), undefined)
})
