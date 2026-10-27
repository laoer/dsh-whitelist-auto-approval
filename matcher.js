/**
 * Command matching for the DSH auto-approval executor.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit-tested outside the Harness. It answers one question: given a command
 * string the model asked `bash` to run, is its *write footprint* contained in
 * the write footprint of an allow-listed program, and which wider file-write
 * policy may it run under?
 *
 * The unit of trust is therefore "what may be written", not "how the command is
 * spelled". A widening grant is defended by exactly one invariant:
 *
 *   the granted command's write footprint ⊆ the matched program's write
 *   footprint
 *
 * The scanner realizes that invariant with one simple pipeline
 * (`command ( '|' command )*`) where the stages after the matched program are
 * stdin→stdout filters from a closed list with an argument-shape whitelist, and
 * every redirect either duplicates a descriptor (`2>&1`) or targets
 * `/dev/null`. Those add no file write at all, so trailing habits such as
 * `2>&1 | tail -12` no longer throw the call back to the approval prompt.
 *
 * Safety stance: anything this scanner does not fully understand is a
 * non-match. A non-match is harmless (the command keeps the session policy and
 * the normal approval prompt); a false match is not. So `> file`, `| tee`,
 * `| sh`, `;`, `&&`, `$(…)` and friends remain non-matches, and a filter whose
 * argument could name a path is refused rather than guessed at.
 *
 * One composition is understood on purpose: a single leading `cd <dir> &&`.
 * Models habitually write it even though the `bash` tool takes a `workdir`, and
 * `cd` only moves the working directory — it grants nothing the tool's own
 * `workdir` parameter does not already grant. Everything after the `&&` is
 * parsed by the same pipeline scanner, so `cd x && a | b` is accepted only
 * when `b` is a write-neutral filter.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

/** Operators that compose more than one command, or expand at run time. */
const REFUSED_META = new Set([';', '&', '(', ')', '{', '}', '`', '$', '!'])
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
 * Read one word starting at `start`, skipping leading blanks.
 *
 * Used for a redirect target, where the word may follow the operator without a
 * space (`>/dev/null`) and quoting behaves like an ordinary argument. Returns
 * `undefined` for an empty target or an expansion, so a redirect whose target
 * cannot be named statically is never accepted.
 *
 * @param {string} command scanned command.
 * @param {number} start first character of the target.
 * @returns {{ text: string, next: number } | undefined}
 */
function readWordAt(command, start) {
  let index = start
  while (index < command.length && (command[index] === ' ' || command[index] === '\t')) index += 1
  if (index >= command.length) return undefined

  let text = ''
  let quote = ''
  let any = false

  for (; index < command.length; index += 1) {
    const ch = command[index]

    if (quote === "'") {
      if (ch === "'") quote = ''
      else text += ch
      any = true
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = ''
        continue
      }
      if (ch === '\\') {
        index += 1
        if (index >= command.length) return undefined
        text += command[index]
        any = true
        continue
      }
      if (ch === '$' || ch === '`') return undefined
      text += ch
      any = true
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      any = true
      continue
    }

    if (ch === '\\') {
      index += 1
      if (index >= command.length) return undefined
      text += command[index]
      any = true
      continue
    }

    if (ch === ' ' || ch === '\t') break
    if (ch === '\n' || ch === '\r' || ch === '\0') return undefined
    // A second operator ends the target (`2>&1|tail`, `>a<b`); the caller
    // resumes scanning there.
    if (ch === '|' || ch === '<' || ch === '>') break
    if (REFUSED_META.has(ch)) return undefined

    text += ch
    any = true
  }

  if (quote !== '') return undefined
  if (!any) return undefined
  return { text, next: index }
}

/**
 * Parse one simple pipeline: `command ( '|' command )*`, where a command is
 * words plus redirects.
 *
 * This is the tolerant scanner. Unlike `tokenize()` it understands the two
 * composition operators `|` and `<`/`>`/`>>` and returns what it found instead
 * of deciding whether it is safe: `match()` applies the write-footprint policy,
 * so the grammar and the policy can change independently.
 *
 * A redirect is `{ fd, op, dup, target }`. `fd` is the descriptor when the
 * digits were adjacent to the operator (`2>&1`); `dup` marks the `&` form.
 *
 * Still refused here, because no faithful representation exists for the text
 * alone: `;`, `&`, `&&`, subshells, braces, expansion (`$`, backtick), `!`,
 * newlines, heredocs (`<<`, `<<<`), and unterminated quotes. `|&` is accepted
 * as the pipe it is: it duplicates `2` into the pipe's descriptor.
 *
 * @param {unknown} command candidate command string.
 * @returns {{ stages: Array<{ argv: string[], redirects: object[] }> } | undefined}
 */
export function parsePipeline(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH) return undefined

  const stages = []
  let argv = []
  let redirects = []
  let token = ''
  let started = false
  let quote = ''

  const flushWord = () => {
    if (!started) return
    argv.push(token)
    token = ''
    started = false
  }

  const endStage = () => {
    flushWord()
    if (argv.length === 0) return false
    stages.push({ argv, redirects })
    argv = []
    redirects = []
    return true
  }

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
      flushWord()
      continue
    }

    if (ch === '\n' || ch === '\r' || ch === '\0') return undefined

    if (ch === '|') {
      if (!endStage()) return undefined
      // `|&` is `2>&1 |`: a descriptor duplicate into the pipe, no path opened.
      if (command[i + 1] === '&') i += 1
      continue
    }

    if (ch === '>' || ch === '<') {
      // Digits adjacent to the operator are the descriptor to redirect
      // (`2>&1`); a separated `2 > x` really is the argument `2` plus a
      // redirect to `x`.
      const fd = started && /^[0-9]{1,2}$/.test(token) ? Number(token) : undefined
      if (fd === undefined) flushWord()
      else {
        token = ''
        started = false
      }

      let op = ch
      if (ch === '>' && command[i + 1] === '>') {
        op = '>>'
        i += 1
      }
      // A heredoc body is not part of this string, so it cannot be scanned.
      if (ch === '<' && command[i + 1] === '<') return undefined

      let dup = false
      if (command[i + 1] === '&') {
        dup = true
        i += 1
      }
      // `>>&`/`<<&` are not shell forms; only `>`/`<` can duplicate a descriptor.
      if (dup && op !== '>' && op !== '<') return undefined

      const target = readWordAt(command, i + 1)
      if (target === undefined) return undefined
      i = target.next - 1
      redirects.push({ fd: fd ?? (ch === '>' ? 1 : 0), op, dup, target: target.text })
      continue
    }

    if (REFUSED_META.has(ch)) return undefined

    token += ch
    started = true
  }

  if (quote !== '') return undefined
  if (!endStage()) return undefined
  return { stages }
}

/**
 * Split a command into argv, or return `undefined` when the command is anything
 * other than one plain invocation.
 *
 * This is the strict reading: one stage, no redirect. It is what
 * `splitCdPrefix()` uses to validate the `cd` half, and what callers that must
 * not accept a pipeline should use.
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
  const parsed = parsePipeline(command)
  if (parsed === undefined || parsed.stages.length !== 1) return undefined
  const [stage] = parsed.stages
  if (stage.redirects.length > 0) return undefined
  return stage.argv
}

/**
 * Recognise a single leading `cd <dir> &&` and split it off.
 *
 * Only the exact shape `cd <one non-option argument> && <rest>` is split; the
 * rest is then handed to `parsePipeline()`, so a second `&&`, a `;`, or a
 * redirection that opens a path still makes the whole command a non-match.
 * Quoting is honoured while looking for the `&&`, so `cd "a && b" && cmd`
 * keeps its target.
 *
 * @param {unknown} command candidate command string.
 * @returns {{ target: string, rest: string } | undefined} split, or undefined.
 */
export function splitCdPrefix(command) {
  if (typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) return undefined

  let start = 0
  while (start < command.length && (command[start] === ' ' || command[start] === '\t')) start += 1
  if (command.slice(start, start + 2) !== 'cd') return undefined
  const separator = command[start + 2]
  if (separator !== ' ' && separator !== '\t') return undefined

  // The first `&&` the shell would see as an operator, skipping quotes and
  // escaped characters. A `&&` inside quotes belongs to an argument.
  let quote = ''
  let split = -1
  for (let i = start + 2; i < command.length - 1; i += 1) {
    const ch = command[i]
    if (quote !== '') {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      split = i
      break
    }
  }
  if (split === -1) return undefined

  const args = tokenize(command.slice(start, split))
  if (args === undefined || args.length !== 2 || args[0] !== 'cd') return undefined
  const target = args[1]
  // A target starting with `-` is an option (`cd -`, `cd -P /x`), not a path.
  if (target === '' || target.startsWith('-')) return undefined

  const rest = command.slice(split + 2)
  if (rest.trim() === '') return undefined
  return { target, rest }
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

/** The directory the allow-listed program will actually run in. */
function resolveCdTarget(target, workdir, home) {
  const expanded = expandHome(target, home)
  return isAbsolute(expanded) ? expanded : resolvePath(workdir, expanded)
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

/**
 * Validate a rule's explicit writable-root list.
 *
 * Every entry must be absolute (or `~/…`), and `/` is refused so one typo
 * cannot turn the host writable. Roots are canonicalized and deduplicated
 * because the overlay compares them as paths.
 *
 * @param {unknown[]} list declared roots.
 * @param {string} label rule label for warnings.
 * @param {string} home canonical home directory.
 * @param {(message: string) => void} warn warning sink.
 * @returns {string[] | undefined} canonical roots, or undefined to drop the rule.
 */
function compileRoots(list, label, home, warn) {
  const roots = []
  for (const entry of Array.isArray(list) ? list : []) {
    const expanded = expandHome(String(entry ?? '').trim(), home)
    if (expanded === '' || !isAbsolute(expanded)) {
      warn(`rule "${label}": every entry in "roots" must be an absolute path or start with "~/" (got ${JSON.stringify(String(entry ?? ''))})`)
      return undefined
    }
    const root = canonicalPath(expanded)
    if (root === '/') {
      warn(`rule "${label}": "roots" cannot contain "/"`)
      return undefined
    }
    if (!roots.includes(root)) roots.push(root)
  }
  if (roots.length === 0) {
    warn(`rule "${label}": "roots" needs at least one directory`)
    return undefined
  }
  return roots
}

/**
 * Compile the writable-root side of a rule.
 *
 * `grant: home` becomes `roots: [$HOME]` and `grant: custom` becomes
 * `roots: [root]`; the explicit `roots` list is the general form. The result
 * always carries a list, so the grant layer has one shape to apply and the
 * overlay can append several roots in one call.
 *
 * @returns {{ kind: string, mode: string, roots: string[] } | undefined}
 */
function compileGrant(raw, label, home, warn) {
  const grant = String(raw.grant ?? 'home')
  const declaredRoots = raw.roots !== undefined

  if (declaredRoots) {
    if (!Array.isArray(raw.roots)) {
      warn(`rule "${label}": "roots" must be an array of directories`)
      return undefined
    }
    if (grant !== 'home' && grant !== 'roots') {
      warn(`rule "${label}": "roots" takes precedence over grant ${JSON.stringify(grant)}`)
    }
    const roots = compileRoots(raw.roots, label, home, warn)
    if (roots === undefined) return undefined
    return { kind: 'roots', mode: 'workspace-write', roots }
  }

  if (grant === 'full') return { kind: 'full', mode: 'danger-full-access', roots: [] }
  if (grant === 'home') return { kind: 'home', mode: 'workspace-write', roots: [canonicalPath(home)] }
  if (grant === 'custom') {
    const root = expandHome(String(raw.root ?? '').trim(), home)
    if (root === '' || !isAbsolute(root)) {
      warn(`rule "${label}": grant "custom" requires an absolute root (got ${JSON.stringify(String(raw.root ?? ''))})`)
      return undefined
    }
    if (canonicalPath(root) === '/') {
      warn(`rule "${label}": "root" cannot be "/"`)
      return undefined
    }
    return { kind: 'custom', mode: 'workspace-write', roots: [canonicalPath(root)] }
  }
  if (grant === 'roots') {
    warn(`rule "${label}": grant "roots" needs a "roots" list of directories`)
    return undefined
  }
  warn(`rule "${label}": unknown grant ${JSON.stringify(grant)} (expected home, custom, roots, or full)`)
  return undefined
}

/** Shapes a rule may accept. `strict` is the default reading. */
const SHAPES = new Set(['strict', 'any'])

/**
 * Compile the shape side of a rule.
 *
 * `any` means the matcher stops reading the grammar and only checks that the
 * allowed program is named somewhere in the command line; the kernel's
 * writable roots become the only bound. That is only defensible when those
 * roots are app-private, so a rule whose roots contain `$HOME` (or an ancestor
 * of it) is refused rather than trusted to the config.
 *
 * @returns {'strict' | 'any' | undefined} shape, or undefined to drop the rule.
 */
function compileShape(raw, label, grant, home, warn) {
  const shape = String(raw.shape ?? 'strict')
  if (!SHAPES.has(shape)) {
    warn(`rule "${label}": unknown shape ${JSON.stringify(shape)} (expected strict or any)`)
    return undefined
  }
  if (shape === 'strict') return 'strict'

  const homePath = canonicalPath(home)
  for (const root of grant.roots) {
    if (isInside(homePath, root)) {
      warn(
        `rule "${label}": shape "any" needs app-private roots, but ${JSON.stringify(root)} contains $HOME; use shape "strict" or narrower roots`,
      )
      return undefined
    }
  }
  return 'any'
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
  const shape = compileShape(raw, label, grant, home, warn)
  if (shape === undefined) return undefined

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
    declared,
    formPath: asPath,
    realPath: asPath === undefined ? undefined : canonicalPath(asPath),
    shape,
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

/** Unquoted characters that end a command word but are not redirects. */
const WORD_SEPARATORS = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '{', '}'])

/**
 * Words of a command line that could name a program, for `shape: any`.
 *
 * This is a deliberately shallow reading: quoting is honoured (a quoted
 * argument is one word, spaces and all), comments and redirect targets are
 * skipped, and everything else splits. It is not a shell parser and does not
 * need to be — a hit only decides *which rule* owns the call, and the writable
 * roots still bound what the call may do.
 *
 * Consequence worth knowing: a program name quoted as its own argument
 * (`echo "lark-cli"`) counts as a mention, while `bash -c "lark-cli …"` does
 * not (the quoted text is one word, not the program).
 *
 * @param {string} command command line.
 * @returns {string[]} candidate words in order.
 */
function scanWords(command) {
  const words = []
  let word = ''
  let started = false
  let quote = ''
  let comment = false

  const flush = () => {
    if (!started) return
    words.push(word)
    word = ''
    started = false
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]

    if (comment) {
      if (ch === '\n') comment = false
      continue
    }

    if (quote !== '') {
      if (ch === quote) {
        quote = ''
        continue
      }
      if (ch === '\\' && quote === '"') {
        i += 1
        if (i >= command.length) break
        word += command[i]
        started = true
        continue
      }
      word += ch
      started = true
      continue
    }

    if (ch === '\\') {
      i += 1
      if (i >= command.length) break
      word += command[i]
      started = true
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }

    // `#` starts a comment only at the start of a word, as in bash.
    if (ch === '#' && !started) {
      comment = true
      continue
    }

    if (ch === '<' || ch === '>') {
      flush()
      const target = readWordAt(command, i + 1)
      if (target !== undefined) i = target.next - 1
      continue
    }

    if (WORD_SEPARATORS.has(ch)) {
      flush()
      continue
    }

    word += ch
    started = true
  }

  flush()
  return words
}

/**
 * Whether an arbitrary command line names the rule's program.
 *
 * Returns `'path'` when the name appears only in a path a model chose
 * (`./lark-cli`, `/tmp/x/lark-cli`): that is the PATH-shadowing vector the
 * strict reading refuses, and it stays refused here.
 *
 * @param {string} invocation command line (a stripped `cd` prefix is fine).
 * @param {object} rule compiled rule.
 * @returns {'name' | 'path' | undefined} mention kind.
 */
function mentionsProgram(invocation, rule) {
  for (const word of scanWords(invocation)) {
    if (rule.name !== undefined) {
      if (word === rule.name) return 'name'
      if (word.includes('/') && basename(word) === rule.name) return 'path'
      continue
    }
    if (word === rule.declared || word === rule.formPath) return 'name'
    if (word.includes('/') && basename(word) === basename(rule.formPath)) return 'path'
  }
  return undefined
}

function filtersPass(rule, command) {
  for (const pattern of rule.deny) if (pattern.test(command)) return false
  if (rule.allow.length > 0 && !rule.allow.some((pattern) => pattern.test(command))) return false
  return true
}

/**
 * Programs allowed to follow a pipe under the *same* grant as the matched one.
 *
 * The list is an argument-shape whitelist, not a name list: every accepted
 * shape only reads stdin and writes stdout, so the pipeline's write footprint
 * stays exactly the matched program's. That is why `tee` (writes a file),
 * `sed -i`, `awk`/`perl` (program-level redirection), `sort -o`, `sh`, and
 * `xargs` are absent, why no filter may take a path operand, and why
 * `tail -f` is refused even though `tail` is listed: following a file is not a
 * stdin→stdout read.
 */
const PIPE_FILTERS = {
  tail: { flags: ['-q', '-v', '--quiet', '--verbose'], counted: ['-n', '-c', '--lines', '--bytes'] },
  head: { flags: ['-q', '-v', '--quiet', '--verbose'], counted: ['-n', '-c', '--lines', '--bytes'] },
  wc: {
    flags: ['-l', '-w', '-c', '-m', '-L', '--lines', '--words', '--bytes', '--chars', '--max-line-length'],
    counted: [],
  },
}

/**
 * Whether a pipeline stage can only read stdin and write stdout.
 *
 * Every argument must be one of the listed flags, a bare count, or a counted
 * option with a numeric value. An operand — which could name a file, a path, or
 * a program — is a refusal, not a guess, so the check does not need to know
 * each filter's full option grammar.
 */
function filterIsNeutral(argv) {
  // Own-property lookup: `constructor`, `toString` and friends are not filters.
  if (!Object.hasOwn(PIPE_FILTERS, argv[0])) return false
  const spec = PIPE_FILTERS[argv[0]]
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (spec.flags.includes(arg)) continue
    if (spec.counted.length > 0) {
      // `tail -12`, `tail -n12`, `tail --lines=12`: a count, still stdin-only.
      if (/^-[0-9]+$/.test(arg)) continue
      if (/^-[nc][0-9]+$/.test(arg)) continue
      if (/^--(lines|bytes)=[0-9]+$/.test(arg)) continue
      if (spec.counted.includes(arg) && /^[0-9]+$/.test(argv[i + 1] ?? '')) {
        i += 1
        continue
      }
    }
    return false
  }
  return true
}

/**
 * Whether a redirect opens no path.
 *
 * Descriptor duplication (`2>&1`, `1>&2`, `>&-`) and `/dev/null` are the only
 * accepted targets: everything else either writes a file the grant would cover
 * or reads one we did not ask about, and a path we cannot canonicalize here is
 * exactly the case that must fall back to the normal approval prompt.
 */
function redirectIsNeutral(redirect) {
  if (redirect.dup) return (redirect.op === '>' || redirect.op === '<') && /^([0-9]+|-)$/.test(redirect.target)
  return redirect.target === '/dev/null'
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
  // `cd <dir> && <cmd>` is understood by default: it is the same request as the
  // tool's `workdir` parameter, just spelled by habit. Operators that dislike
  // even that shape can set `allowCdPrefix: false` and keep the strict reading.
  const allowCdPrefix = options.allowCdPrefix !== false

  const compiled = []
  for (const [index, raw] of (Array.isArray(rules) ? rules : []).entries()) {
    const rule = compileRule(raw, index, home, warn)
    if (rule === undefined) continue
    // A strict rule needs the binary on PATH to match at all; an `any`-shaped
    // rule matches a mention, so a PATH miss is not a rule that can never fire.
    if (rule.shape === 'strict') {
      const probe = rule.realPath !== undefined ? executableAt(rule.realPath) : findInPath(rule.name, searchPath)
      if (probe === undefined) warn(`rule "${rule.label}": ${JSON.stringify(rule.name ?? rule.realPath)} is not on this PATH, so it will never match (add its directory to "extraPath")`)
    }
    compiled.push(rule)
  }

  return function match(command, context = {}) {
    if (compiled.length === 0) {
      onDecision({ reason: 'no-rules' })
      return undefined
    }

    const workdir = context.workdir ?? process.cwd()
    const cd = allowCdPrefix ? splitCdPrefix(command) : undefined
    const invocation = cd === undefined ? command : cd.rest
    // A relative path-form argv[0] (`./x`, `bin/x`) must be resolved from the
    // directory the shell will actually be in, exactly as it runs. Bare names
    // still come from PATH, and the workspace/tmp check below runs on the real
    // path either way.
    const cwd = cd === undefined ? workdir : resolveCdTarget(cd.target, workdir, home)

    // The strict reading is computed at most once, and only when a `strict`
    // rule is actually reached: an `any`-shaped rule never looks at the grammar,
    // so a command that cannot be parsed is still matchable by such a rule.
    let strict
    let strictFailure

    const strictFacts = () => {
      if (strict !== undefined) return strict
      strict = null

      const parsed = parsePipeline(invocation)
      if (parsed === undefined) {
        strictFailure = { reason: 'not-simple', command }
        return null
      }
      const [head, ...piped] = parsed.stages

      const executable = resolveExecutable(head.argv[0], { searchPath, cwd, home })
      if (executable === undefined) {
        strictFailure = { reason: 'not-found', argv0: head.argv[0], path: searchPath }
        return null
      }

      // A repository- or temp-supplied binary is never the trusted program:
      // that is the one way a name lookup can be redirected by the model.
      if (context.workspaceRoot !== undefined && isInside(executable.real, canonicalPath(context.workspaceRoot))) {
        strictFailure = { reason: 'workspace-binary', executable: executable.real, workspaceRoot: context.workspaceRoot }
        return null
      }
      if (isInside(executable.real, '/tmp') || isInside(executable.real, tempRoot)) {
        strictFailure = { reason: 'temp-binary', executable: executable.real }
        return null
      }

      // The grant covers the whole `bash -c` tree, so every other stage and
      // every redirect has to add no write of its own. Checking this before the
      // rule loop keeps a "near miss" an ordinary non-match rather than a
      // partial grant, and it is what makes `2>&1 | tail -12` safe to accept
      // while `> out.log` and `| tee out.log` stay refused.
      if (!head.redirects.every(redirectIsNeutral)) {
        strictFailure = { reason: 'redirect', command, redirects: head.redirects }
        return null
      }
      const pipeline = []
      for (const [index, stage] of piped.entries()) {
        const stageNumber = index + 1
        if (stage.argv[0].includes('/') || !filterIsNeutral(stage.argv) || !stage.redirects.every(redirectIsNeutral)) {
          strictFailure = { reason: 'pipe-not-neutral', command, stage: stageNumber, argv: stage.argv }
          return null
        }
        const filter = resolveExecutable(stage.argv[0], { searchPath, cwd, home })
        if (filter === undefined || filter.name !== stage.argv[0]) {
          strictFailure = { reason: 'pipe-not-found', stage: stageNumber, argv0: stage.argv[0] }
          return null
        }
        // Filters get the same shadowing checks as the matched program; a
        // repository-supplied `tail` must not inherit a grant.
        if (context.workspaceRoot !== undefined && isInside(filter.real, canonicalPath(context.workspaceRoot))) {
          strictFailure = { reason: 'workspace-binary', executable: filter.real, workspaceRoot: context.workspaceRoot }
          return null
        }
        if (isInside(filter.real, '/tmp') || isInside(filter.real, tempRoot)) {
          strictFailure = { reason: 'temp-binary', executable: filter.real }
          return null
        }
        pipeline.push(stage.argv[0])
      }

      strict = { head, executable, pipeline }
      return strict
    }

    let failure
    for (const rule of compiled) {
      let hit
      if (rule.shape === 'any') {
        // No grammar reading: the program only has to be named as a word, and
        // the kernel enforces the (app-private) roots.
        const mention = mentionsProgram(invocation, rule)
        if (mention === 'path') {
          failure ??= { reason: 'path-form', rule: rule.label, command }
        }
        hit = mention === 'name'
      } else {
        const facts = strictFacts()
        if (facts === null) failure ??= strictFailure
        else hit = ruleMatches(rule, facts.head.argv[0], facts.executable)
      }
      if (!hit) continue

      if (!filtersPass(rule, command)) {
        onDecision({ reason: 'filtered', rule: rule.label, command })
        return undefined
      }
      onDecision({
        reason: 'matched',
        rule: rule.label,
        shape: rule.shape,
        grant: rule.grant,
        ...(cd === undefined ? {} : { cd: cd.target, cwd }),
        ...(rule.shape === 'any' || strict === null || strict === undefined
          ? {}
          : {
              executable: strict.executable.real,
              ...(strict.pipeline.length === 0 ? {} : { pipeline: strict.pipeline }),
            }),
      })
      return { rule: rule.label, grant: rule.grant }
    }

    onDecision(failure ?? { reason: 'no-rule', rules: compiled.map((rule) => rule.label) })
    return undefined
  }
}
