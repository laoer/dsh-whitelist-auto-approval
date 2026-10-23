/**
 * Command matching for the DSH auto-approval executor.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit-tested outside the Harness. It answers one question: given a command
 * string the model asked `bash` to run, is this *exactly one simple invocation*
 * of an allow-listed program, and which wider file-write policy may it run under?
 *
 * Safety stance: anything this scanner does not fully understand is a
 * non-match. A non-match is harmless (the command keeps the session policy and
 * the normal approval prompt); a false match is not.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

/** Shell operators that compose more than one command, or expand at run time. */
const SHELL_META = new Set([';', '&', '|', '<', '>', '(', ')', '{', '}', '`', '$', '!'])
/** Refuse absurd inputs instead of scanning them. */
const MAX_COMMAND_LENGTH = 8192

function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function isInside(child, parent) {
  if (child === parent) return true
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(base)
}

/**
 * Split a command into argv, or return `undefined` when the command is anything
 * other than one plain invocation.
 *
 * Accepted: quoting, backslash escapes, leading/trailing whitespace.
 * Refused: newlines, `;` `&` `|` `<` `>` `(` `)` `{` `}` `` ` `` `$` `!`
 * outside quotes, `$` or a backtick inside double quotes (expansion), and
 * unterminated quotes.
 *
 * Characters *inside* quotes are not executed by the shell, so they are kept
 * verbatim: `lark-cli im +send --text "a; b"` still tokenizes.
 *
 * @param {unknown} command candidate command string.
 * @returns {string[] | undefined} argv, or undefined when the command is not simple.
 */
export function tokenize(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH) return undefined

  const argv = []
  let token = ''
  let started = false
  let quote = ''

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]

    if (quote === "'") {
      if (ch === "'") quote = ''
      else token += ch
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = ''
        continue
      }
      if (ch === '\\') {
        const next = command[i + 1]
        if (next === undefined || next === '\n' || next === '\r') return undefined
        i += 1
        token += next
        continue
      }
      // Double quotes still expand: refuse rather than guess.
      if (ch === '$' || ch === '`') return undefined
      token += ch
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }

    if (ch === '\\') {
      const next = command[i + 1]
      if (next === undefined || next === '\n' || next === '\r') return undefined
      i += 1
      token += next
      started = true
      continue
    }

    if (ch === ' ' || ch === '\t') {
      if (started) {
        argv.push(token)
        token = ''
        started = false
      }
      continue
    }

    if (ch === '\n' || ch === '\r' || ch === '\0') return undefined
    if (SHELL_META.has(ch)) return undefined

    token += ch
    started = true
  }

  if (quote !== '') return undefined
  if (started) argv.push(token)
  return argv
}

function executableAt(path) {
  try {
    if (!statSync(path).isFile()) return undefined
    accessSync(path, constants.X_OK)
    // Keep both spellings: a symlinked CLI (very common) has a target basename
    // that differs from the invoked name, while the trust checks must run on
    // the real file.
    return { real: canonicalPath(path), name: basename(path) }
  } catch {
    return undefined
  }
}

/**
 * Resolve `argv[0]` the way the confined `bash -c` would: PATH lookup for a
 * bare name, cwd-relative for a path. Symlinks are resolved so the trust check
 * sees the real file.
 */
function findInPath(name, searchPath) {
  for (const dir of searchPath.split(':')) {
    if (dir === '') continue
    const hit = executableAt(join(dir, name))
    if (hit !== undefined) return hit
  }
  return undefined
}

function resolveExecutable(argv0, { searchPath, cwd, home }) {
  if (argv0.includes('/')) {
    const expanded = expandHome(argv0, home)
    return executableAt(isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded))
  }
  return findInPath(argv0, searchPath)
}

function expandHome(path, home) {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function compileRegexes(list, label, field, warn) {
  const patterns = []
  for (const raw of Array.isArray(list) ? list : []) {
    const source = String(raw ?? '').trim()
    if (source === '') continue
    try {
      patterns.push(new RegExp(source))
    } catch (error) {
      // An invalid pattern could silently widen the rule (a lost deny) or
      // silently narrow it (a lost allow), so the whole rule is dropped.
      warn(`rule "${label}": invalid ${field} regex ${JSON.stringify(source)}: ${String(error)}`)
      return undefined
    }
  }
  return patterns
}

function compileGrant(raw, label, home, warn) {
  const grant = String(raw.grant ?? 'home')
  if (grant === 'full') return { mode: 'danger-full-access' }
  if (grant === 'home') return { mode: 'workspace-write', workspaceRoot: canonicalPath(home) }
  if (grant === 'custom') {
    const root = expandHome(String(raw.root ?? '').trim(), home)
    if (root === '' || !isAbsolute(root)) {
      warn(`rule "${label}": grant "custom" requires an absolute root (got ${JSON.stringify(String(raw.root ?? ''))})`)
      return undefined
    }
    return { mode: 'workspace-write', workspaceRoot: canonicalPath(root) }
  }
  warn(`rule "${label}": unknown grant ${JSON.stringify(grant)} (expected home, full, or custom)`)
  return undefined
}

function compileRule(raw, index, home, warn) {
  if (raw === null || typeof raw !== 'object') {
    warn(`rule #${index}: expected an object`)
    return undefined
  }
  const declared = String(raw.command ?? '').trim()
  if (declared === '' || /\s/.test(declared)) {
    warn(`rule #${index}: "command" must be one executable name or absolute path without spaces`)
    return undefined
  }

  const label = String(raw.name ?? '').trim() || declared
  const grant = compileGrant(raw, label, home, warn)
  if (grant === undefined) return undefined

  const deny = compileRegexes(raw.deny, label, 'deny', warn)
  if (deny === undefined) return undefined
  const allow = compileRegexes(raw.allow, label, 'allow', warn)
  if (allow === undefined) return undefined

  const asPath = declared.includes('/') ? expandHome(declared, home) : undefined
  if (asPath !== undefined && !isAbsolute(asPath)) {
    warn(`rule "${label}": a path-form command must be absolute or start with "~/"`)
    return undefined
  }

  return {
    label,
    // Path-form rules match by resolved realpath; name-form rules match a bare
    // invocation whose resolved binary keeps the same basename.
    name: asPath === undefined ? declared : undefined,
    realPath: asPath === undefined ? undefined : canonicalPath(asPath),
    grant,
    deny,
    allow,
  }
}

function ruleMatches(rule, argv0, executable) {
  if (rule.realPath !== undefined) return executable.real === rule.realPath
  // `./lark-cli` or `/opt/x/lark-cli` must be configured as an explicit path:
  // a model-chosen path is exactly the shadowing vector this plugin refuses.
  if (argv0.includes('/')) return false
  return argv0 === rule.name && (executable.name === rule.name || basename(executable.real) === rule.name)
}

function filtersPass(rule, command) {
  for (const pattern of rule.deny) if (pattern.test(command)) return false
  if (rule.allow.length > 0 && !rule.allow.some((pattern) => pattern.test(command))) return false
  return true
}

/**
 * Compile the configured rules once, then match commands against them.
 *
 * @param {Array<object>} rules configured rules (`command`, `grant`, `root`, `deny`, `allow`).
 * @param {object} [options] injectable environment for tests.
 * @returns {(command: string, context: { workspaceRoot?: string, workdir?: string }) => ({ rule: string, grant: object } | undefined)}
 */
export function createMatcher(rules, options = {}) {
  const home = canonicalPath(options.home ?? homedir())
  const tempRoot = canonicalPath(options.tmp ?? tmpdir())
  const env = options.env ?? process.env
  const warn = options.onWarning ?? (() => {})
  // The PATH the confined `bash -c` will search is the Host process PATH; a
  // GUI launch can give it a minimal value, in which case a rule can never
  // match. Surface that at load time instead of failing silently later.
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : () => {}
  const extraPath = (Array.isArray(options.extraPath) ? options.extraPath : []).map((entry) => String(entry ?? '').trim()).filter((entry) => entry !== '')
  const searchPath = [typeof env.PATH === 'string' ? env.PATH : '', ...extraPath].filter((entry) => entry !== '').join(':')

  const compiled = []
  for (const [index, raw] of (Array.isArray(rules) ? rules : []).entries()) {
    const rule = compileRule(raw, index, home, warn)
    if (rule === undefined) continue
    const probe = rule.realPath !== undefined ? executableAt(rule.realPath) : findInPath(rule.name, searchPath)
    if (probe === undefined) warn(`rule "${rule.label}": ${JSON.stringify(rule.name ?? rule.realPath)} is not on this PATH, so it will never match (add its directory to "extraPath")`)
    compiled.push(rule)
  }

  return function match(command, context = {}) {
    if (compiled.length === 0) {
      onDecision({ reason: 'no-rules' })
      return undefined
    }
    const argv = tokenize(command)
    if (argv === undefined || argv.length === 0) {
      onDecision({ reason: 'not-simple', command })
      return undefined
    }

    const cwd = context.workdir ?? process.cwd()
    const executable = resolveExecutable(argv[0], { searchPath, cwd, home })
    if (executable === undefined) {
      onDecision({ reason: 'not-found', argv0: argv[0], path: searchPath })
      return undefined
    }

    // A repository- or temp-supplied binary is never the trusted program: that
    // is the one way a name lookup can be redirected by the model itself.
    if (context.workspaceRoot !== undefined && isInside(executable.real, canonicalPath(context.workspaceRoot))) {
      onDecision({ reason: 'workspace-binary', executable: executable.real, workspaceRoot: context.workspaceRoot })
      return undefined
    }
    if (isInside(executable.real, '/tmp') || isInside(executable.real, tempRoot)) {
      onDecision({ reason: 'temp-binary', executable: executable.real })
      return undefined
    }

    for (const rule of compiled) {
      if (!ruleMatches(rule, argv[0], executable)) continue
      if (!filtersPass(rule, command)) {
        onDecision({ reason: 'filtered', rule: rule.label, command })
        return undefined
      }
      onDecision({ reason: 'matched', rule: rule.label, executable: executable.real, grant: rule.grant })
      return { rule: rule.label, grant: rule.grant }
    }
    onDecision({ reason: 'no-rule', argv0: argv[0], executable: executable.real, rules: compiled.map((rule) => rule.label) })
    return undefined
  }
}
