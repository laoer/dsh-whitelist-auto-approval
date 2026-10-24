import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyExtraWritableRoots, normalizeExtraRoots } from '../overlay.js'

const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-overlay-'))
const EXTRA = join(SCRATCH, 'extra')
mkdirSync(EXTRA, { recursive: true })

const ROOT = normalizeExtraRoots([EXTRA])[0]
const MISSING = join(SCRATCH, 'missing')

const basePolicy = { mode: 'workspace-write', workspaceRoot: '/work', extraWritableRoots: [ROOT] }

function seatbelt(argv = ['sandbox-exec', '-p', '(version 1)(allow default)(deny file-write*)', '--', 'bash', '-c', 'x']) {
  return { argv, enforcement: 'full', denialSignatures: ['operation not permitted'], runnerFailureRules: [] }
}

function hooks() {
  const seen = { warnings: [], trace: [], unsupported: [] }
  return {
    seen,
    trace: (event, detail) => seen.trace.push([event, detail]),
    warn: (message) => seen.warnings.push(message),
    onUnsupported: (message) => seen.unsupported.push(message),
  }
}

test('normalize: keeps only absolute, non-root, deduplicated paths', () => {
  assert.deepEqual(normalizeExtraRoots([EXTRA, EXTRA, 'relative', '/', '', '   ', null]), [ROOT])
  assert.deepEqual(normalizeExtraRoots(undefined), [])
})

test('seatbelt: appends an allow form and keeps the rest of the result', () => {
  const result = seatbelt()
  const out = applyExtraWritableRoots(result, basePolicy, hooks())
  assert.equal(out.enforcement, 'full')
  assert.deepEqual(out.denialSignatures, ['operation not permitted'])
  assert.ok(out.argv[2].includes(`(allow file-write* (subpath "${ROOT}"))`), out.argv[2])
})

test('seatbelt: escapes quotes and backslashes in the profile literal', () => {
  const quoted = '/Users/tester/a"b'
  const out = applyExtraWritableRoots(seatbelt(), { ...basePolicy, extraWritableRoots: [quoted] }, hooks())
  assert.ok(out.argv[2].includes(`(subpath "/Users/tester/a\\"b")`), out.argv[2])
})

test('seatbelt: a profile that already grants the root is left alone', () => {
  const result = seatbelt(['sandbox-exec', '-p', `(allow file-write* (subpath "${ROOT}"))`, '--', 'bash'])
  const out = applyExtraWritableRoots(result, basePolicy, hooks())
  assert.equal(out, result)
})

test('seatbelt: a missing -p profile warns and returns the shipped argv', () => {
  const result = seatbelt(['sandbox-exec', '--', 'bash'])
  const h = hooks()
  const out = applyExtraWritableRoots(result, basePolicy, h)
  assert.equal(out, result)
  assert.equal(h.seen.warnings.length, 1)
})

test('bwrap: inserts a bind pair before the command separator', () => {
  const result = seatbelt(['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work', '--', 'bash', '-c', 'x'])
  const out = applyExtraWritableRoots(result, basePolicy, hooks())
  const separator = out.argv.indexOf('--')
  assert.deepEqual(out.argv.slice(separator - 3, separator), ['--bind', ROOT, ROOT])
})

test('bwrap: an existing bind is not repeated', () => {
  const result = seatbelt(['bwrap', '--bind', ROOT, ROOT, '--', 'bash'])
  const out = applyExtraWritableRoots(result, basePolicy, hooks())
  assert.equal(out, result)
})

test('bwrap: a missing bind source is skipped with a warning', () => {
  const result = seatbelt(['bwrap', '--bind', '/work', '/work', '--', 'bash'])
  const h = hooks()
  const out = applyExtraWritableRoots(result, { ...basePolicy, extraWritableRoots: [MISSING] }, h)
  assert.equal(out, result)
  assert.equal(h.seen.warnings.length, 1)
})

test('landlock: inserts an --rw grant before the command separator', () => {
  const result = seatbelt(['/opt/landlock-run', '--ro', '/', '--rw', '/tmp', '--rw', '/work', '--', 'bash'])
  const out = applyExtraWritableRoots(result, basePolicy, hooks())
  const separator = out.argv.indexOf('--')
  assert.deepEqual(out.argv.slice(separator - 2, separator), ['--rw', ROOT])
})

test('landlock: an existing --rw grant is not repeated', () => {
  const result = seatbelt(['/opt/landlock-run', '--rw', ROOT, '--', 'bash'])
  const out = applyExtraWritableRoots(result, basePolicy, hooks())
  assert.equal(out, result)
})

test('an unrecognized runner reports unsupported and stays untouched', () => {
  const result = seatbelt(['mystery-sandbox', '--', 'bash'])
  const h = hooks()
  const out = applyExtraWritableRoots(result, basePolicy, h)
  assert.equal(out, result)
  assert.equal(h.seen.unsupported.length, 1)
  assert.equal(h.seen.trace.length, 0)
})

test('non workspace-write modes and empty root lists are no-ops', () => {
  const readOnly = seatbelt()
  assert.equal(applyExtraWritableRoots(readOnly, { ...basePolicy, mode: 'read-only' }, hooks()), readOnly)

  const empty = seatbelt()
  assert.equal(applyExtraWritableRoots(empty, { ...basePolicy, extraWritableRoots: [] }, hooks()), empty)
})

test('root is refused instead of turning the host writable', () => {
  const result = seatbelt()
  const out = applyExtraWritableRoots(result, { ...basePolicy, extraWritableRoots: ['/'] }, hooks())
  assert.equal(out, result)
})
