/**
 * Extra-writable-root overlay for the mounted sandbox provider.
 *
 * `SandboxExecutionPolicy` carries one `workspaceRoot`, and the shipped
 * providers derive their writable allow-list from it. A whitelisted CLI such
 * as `lark-cli` often needs two roots in the same call: its own state under
 * `$HOME` and the session workspace (downloads, exports). Replacing the root
 * loses one side, so this module extends the other end of the seam instead:
 * the `ctx.sandbox.confine()` result. The shipped provider already returns the
 * final runner argv, so appending to that argv is the only way to widen the
 * allow-list without forking the sandbox provider.
 *
 * Per-runner overlays:
 *
 * - Seatbelt (`sandbox-exec -p '<profile>' -- ...`): append
 *   `(allow file-write* (subpath "<root>"))` to the profile string. SBPL
 *   evaluates rules in order and the last matching rule wins; the shipped
 *   profile ends with its own allow-list, so an appended allow takes effect.
 * - bwrap: insert `--bind <root> <root>` before the `--` separator. Mounts are
 *   applied in order and a later bind shadows an earlier one.
 * - Landlock: insert `--rw <root>` before the `--` separator. Its grant list is
 *   a union, so an extra writable root needs no ordering.
 *
 * The overlay is additive and fail-open: an unknown runner, a missing profile
 * flag, a missing bind source or any thrown error leaves the shipped argv
 * untouched. It never turns a confined execution into an unconfined one; the
 * worst case is "the extra root was not added".
 *
 * Idempotence: a root the argv already grants is not added again. That keeps
 * this module a pure fallback for a future engine that understands
 * `extraWritableRoots` itself.
 *
 * @module dsh-whitelist-auto-approval/overlay
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

/** Points from an installed wrapper back to the function it wrapped. */
const ORIGINAL = Symbol.for('dsh-whitelist-auto-approval.sandbox-original')

const SEATBELT_RUNNER = 'sandbox-exec'
const BWRAP_RUNNER = 'bwrap'

/**
 * Resolve a root the way the sandbox compares paths. Both Seatbelt filters and
 * the fs fence canonicalize, so an as-spelled root must be canonicalized too;
 * a path that cannot be resolved keeps its spelling (it matches nothing until
 * it exists, which is the conservative outcome).
 */
function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Quote one path as an SBPL string literal. */
function sbplString(path) {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Accept only absolute, single-line, non-root paths, canonicalized and
 * deduplicated. Root is refused: adding it would turn the whole host writable
 * for this call, which is what `grant: full` already expresses explicitly.
 *
 * @param {unknown} list candidate roots from the policy.
 * @returns {string[]} usable roots.
 */
export function normalizeExtraRoots(list) {
  if (!Array.isArray(list)) return []
  const roots = []
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '' || !isAbsolute(trimmed)) continue
    if (/[\0\n\r]/.test(trimmed)) continue
    const root = canonicalPath(trimmed)
    if (root === '' || root === '/') continue
    if (seen.has(root)) continue
    seen.add(root)
    roots.push(root)
  }
  return roots
}

/** Whether the bwrap profile already binds `root` read-write. */
function bwrapHasBind(argv, limit, root) {
  for (let index = 0; index + 2 < limit; index += 1) {
    if (argv[index] === '--bind' && argv[index + 1] === root && argv[index + 2] === root) return true
  }
  return false
}

/** Whether the Landlock profile already grants `--rw root`. */
function landlockHasRw(argv, limit, root) {
  for (let index = 0; index + 1 < limit; index += 1) {
    if (argv[index] === '--rw' && argv[index + 1] === root) return true
  }
  return false
}

/** Append the extra roots to the Seatbelt profile string. */
function applySeatbelt(result, roots, hooks) {
  const argv = result.argv
  const profileIndex = argv.indexOf('-p')
  if (profileIndex === -1 || profileIndex + 1 >= argv.length) {
    hooks.warn('the Seatbelt argv has no -p profile to extend; extra writable roots were ignored')
    return result
  }
  const profile = String(argv[profileIndex + 1])
  const missing = roots.filter((root) => !profile.includes(`(subpath ${sbplString(root)})`))
  if (missing.length === 0) return result
  const form = `(allow file-write* ${missing.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`
  const next = [...argv]
  next[profileIndex + 1] = `${profile} ${form}`
  hooks.trace('overlay-append', { dialect: 'seatbelt', roots: missing })
  return { ...result, argv: next }
}

/** Insert bwrap binds before the command separator. */
function applyBwrap(result, roots, hooks) {
  const argv = result.argv
  const separator = argv.indexOf('--')
  if (separator === -1) {
    hooks.warn('the bwrap argv has no -- separator to insert before; extra writable roots were ignored')
    return result
  }
  const missing = roots.filter((root) => !bwrapHasBind(argv, separator, root))
  if (missing.length === 0) return result
  const usable = []
  const absent = []
  for (const root of missing) (existsSync(root) ? usable : absent).push(root)
  if (absent.length > 0) hooks.warn(`bwrap cannot bind missing paths, skipped: ${absent.join(', ')}`)
  if (usable.length === 0) return result
  const binds = usable.flatMap((root) => ['--bind', root, root])
  hooks.trace('overlay-append', { dialect: 'bwrap', roots: usable })
  return { ...result, argv: [...argv.slice(0, separator), ...binds, ...argv.slice(separator)] }
}

/** Insert Landlock `--rw` grants before the command separator. */
function applyLandlock(result, roots, hooks) {
  const argv = result.argv
  const separator = argv.indexOf('--')
  if (separator === -1) {
    hooks.warn('the Landlock argv has no -- separator to insert before; extra writable roots were ignored')
    return result
  }
  const missing = roots.filter((root) => !landlockHasRw(argv, separator, root))
  if (missing.length === 0) return result
  const usable = []
  const absent = []
  for (const root of missing) (existsSync(root) ? usable : absent).push(root)
  if (absent.length > 0) hooks.warn(`Landlock cannot grant missing paths, skipped: ${absent.join(', ')}`)
  if (usable.length === 0) return result
  const grants = usable.flatMap((root) => ['--rw', root])
  hooks.trace('overlay-append', { dialect: 'landlock', roots: usable })
  return { ...result, argv: [...argv.slice(0, separator), ...grants, ...argv.slice(separator)] }
}

/**
 * Apply the policy's `extraWritableRoots` to one `ConfinedArgv`.
 *
 * Returns the input untouched whenever the overlay does not apply: a
 * non-confined mode, no roots, an unrecognized runner, a malformed profile, or
 * a root the runner cannot grant. Callers must treat this as best effort.
 *
 * @param {{ argv?: unknown }} result the shipped provider's `ConfinedArgv`.
 * @param {{ mode?: string, extraWritableRoots?: unknown }} policy the call policy.
 * @param {{
 *   trace?: (event: string, detail?: object) => void,
 *   warn?: (message: string) => void,
 *   onUnsupported?: (message: string) => void,
 * }} [hooks] diagnostics; `onUnsupported` fires for a runner with no overlay.
 * @returns the original result, or a copy with the extended argv.
 */
export function applyExtraWritableRoots(result, policy, hooks = {}) {
  const trace = typeof hooks.trace === 'function' ? hooks.trace : () => {}
  const warn = typeof hooks.warn === 'function' ? hooks.warn : () => {}
  const onUnsupported = typeof hooks.onUnsupported === 'function' ? hooks.onUnsupported : () => {}

  if (result === null || typeof result !== 'object' || !Array.isArray(result.argv)) return result
  if (policy === null || typeof policy !== 'object' || policy.mode !== 'workspace-write') return result

  const roots = normalizeExtraRoots(policy.extraWritableRoots)
  if (roots.length === 0) return result

  const argv = result.argv
  const runner = basename(String(argv[0] ?? ''))
  const context = { trace, warn }

  if (runner === SEATBELT_RUNNER) return applySeatbelt(result, roots, context)
  if (runner === BWRAP_RUNNER) return applyBwrap(result, roots, context)

  const separator = argv.indexOf('--')
  if (separator !== -1 && argv.slice(1, separator).includes('--rw')) return applyLandlock(result, roots, context)

  onUnsupported(`the "${runner || '(unknown)'}" sandbox runner cannot be extended from outside; extra writable roots were ignored`)
  return result
}

/**
 * Decorate the live `ctx.sandbox.confine()`. The overlay only reacts to
 * policies that carry `extraWritableRoots`, so every other confined call keeps
 * the shipped argv byte for byte.
 *
 * A failure here can never break confinement: an unrecognized runner or a bad
 * argv returns the shipped result. `onReady(false)` on an unrecognized runner
 * lets the caller fall back to the old replace-the-root grant for later calls.
 *
 * @param {object} ctx cordis context.
 * @param {{
 *   isSupported: () => boolean,
 *   onReady: (ready: boolean) => void,
 *   logger?: { warn?: (message: string) => void },
 *   trace?: (event: string, detail?: object) => void,
 * }} options deployment hooks.
 * @returns the disposer owned by the caller (or a no-op when unsupported).
 */
export function installSandboxOverlay(ctx, options = {}) {
  const isSupported = typeof options.isSupported === 'function' ? options.isSupported : () => false
  const onReady = typeof options.onReady === 'function' ? options.onReady : () => {}
  const trace = typeof options.trace === 'function' ? options.trace : () => {}
  const logger = options.logger
  const warned = new Set()

  const warn = (message) => {
    if (warned.has(message)) return
    warned.add(message)
    trace('overlay-warning', { message })
    try {
      logger?.warn?.(`[auto-approval] ${message}`)
    } catch {
      /* logging must never affect confinement */
    }
  }

  if (!isSupported()) {
    trace('overlay-skip', { reason: 'platform' })
    return () => {}
  }
  if (typeof ctx?.inject !== 'function') {
    trace('overlay-skip', { reason: 'no-inject' })
    return () => {}
  }

  return ctx.inject(['sandbox'], (scope) => scope.effect(() => {
    const sandbox = scope.sandbox
    if (sandbox === undefined || typeof sandbox.confine !== 'function') {
      trace('overlay-skip', { reason: 'no-sandbox' })
      return () => {}
    }

    // Flatten any earlier generation of this same plugin back to the original.
    const base = sandbox.confine[ORIGINAL] ?? sandbox.confine

    const patched = async function confine(argv, policy, signal) {
      const result = await base.call(this, argv, policy, signal)
      try {
        return applyExtraWritableRoots(result, policy, {
          trace,
          warn,
          onUnsupported: (message) => {
            warn(message)
            onReady(false)
          },
        })
      } catch (error) {
        warn(`the extra-writable-root overlay failed and the shipped argv was kept: ${String(error)}`)
        return result
      }
    }

    patched[ORIGINAL] = base
    try {
      sandbox.confine = patched
    } catch (error) {
      warn(`the extra-writable-root overlay could not decorate confine(): ${String(error)}`)
      return () => {}
    }

    trace('overlay-installed', { platform: process.platform, identity: sandbox.confine === patched })
    onReady(true)

    return () => {
      onReady(false)
      if (sandbox.confine === patched) sandbox.confine = base
      trace('overlay-removed', {})
    }
  }))
}
