/**
 * Per-command sandbox allow-list for the DSH `bash` tool.
 *
 * Problem: a CLI such as `lark-cli` writes outside the session workspace
 * (`~/.lark-cli`, `~/Library/Application Support/lark-cli`). Under
 * `workspace-write` the kernel denies that write, the model retries with
 * `sandbox_permissions: danger-full-access`, and the user gets an approval
 * prompt for *full* access — for a command that only needs its own home files.
 *
 * Fix: decorate the live `ctx.shell.resolve()`. For a configured command the
 * spec's per-call `sandboxPolicy` is widened to `workspace-write` with `$HOME`
 * as the writable root, so the first attempt already succeeds and the
 * escalation dance never starts. Every other call keeps the standing policy
 * and the normal approval prompt.
 *
 * This plugin does not replace `ctx.shell` or register a service. A failure
 * here can therefore never leave the composition without a shell — the worst
 * case is "no command is granted". The optional `Config` schema adds the
 * management page; without it the plugin still runs from raw YAML config.
 *
 * The sandbox governs file *writes* only: reads and network are unrestricted
 * under every mode. So the difference between this grant and `danger-full-access`
 * is "may write under $HOME" versus "may write anywhere, unconfined".
 *
 * @module dsh-whitelist-auto-approval
 */

import { appendFileSync } from 'node:fs'
import { createMatcher } from './matcher.js'
import { installSandboxOverlay } from './overlay.js'

/**
 * The row's `Config` schema. Exported from a separate module because it pulls
 * in the vendored schemastery copy and belongs to the settings surface, not to
 * the shell decoration.
 */
export { Config } from './schema.js'

/**
 * Points from an installed wrapper back to the function it wrapped, so a
 * reload flattens the chain instead of stacking another layer. Stacking would
 * make a later layer see an already-granted `workspaceRoot` and mistake the
 * trusted binary for a workspace-supplied one.
 */
const ORIGINAL = Symbol.for('dsh-whitelist-auto-approval.original')

const MAX_LOGGED_COMMAND = 500
/** Stable identity for "no rules", so the lazy compiler does not rebuild on every call. */
const NO_RULES = []

/**
 * Append one root to a policy's additional-root list without duplicating it.
 * Keeps the original array reference when the root is already present.
 */
function addRoot(existing, root) {
  const roots = Array.isArray(existing) ? existing : []
  return roots.includes(root) ? roots : [...roots, root]
}

/**
 * Read the rules out of the resolved config.
 *
 * A `.volatile()` field arrives as a stable reference with `get()` rather than
 * as the plain array. The loader updates that reference in place when the
 * settings page saves, so every call must read through it instead of keeping
 * the value seen at `apply` time. A plain array is accepted for tests, older
 * configs, and deployments where no schema was resolved.
 */
function readRules(config) {
  const value = typeof config?.rules?.get === 'function' ? config.rules.get() : config?.rules
  return Array.isArray(value) ? value : NO_RULES
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   rules?: object[],
 *   audit?: boolean,
 *   upgradeFromReadOnly?: boolean,
 *   extraPath?: string[],
 *   trace?: string,
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const audit = config.audit !== false
  const upgradeFromReadOnly = config.upgradeFromReadOnly === true
  const initialRules = readRules(config)
  const traceFile = typeof config.trace === 'string' && config.trace.trim() !== '' ? config.trace.trim() : undefined

  /** Opt-in JSONL journal, for when the Host log is not reachable. */
  const trace = (event, detail = {}) => {
    if (traceFile === undefined) return
    try {
      appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`)
    } catch {
      /* tracing must never affect execution */
    }
  }

  trace('apply', { rules: initialRules.length, path: process.env.PATH ?? '' })

  /**
   * Whether the provider overlay is mounted. `grant: home` is additive only
   * while this is true; Windows and an unrecognized provider keep the old
   * replace-the-root behavior.
   */
  const overlayState = { ready: false }

  const matcherOptions = {
    extraPath: config.extraPath ?? [],
    allowCdPrefix: config.allowCdPrefix !== false,
    onDecision: (info) => trace('decision', info),
    onWarning: (message) => {
      trace('warning', { message })
      ctx.logger.warn(`[auto-approval] ${message}`)
    },
  }

  // Rules are compiled lazily and rebuilt when the volatile reference changes.
  // Keeping this out of `apply` is what lets a settings save take effect for the
  // next bash call without remounting the plugin.
  let compiledSource
  let compiledMatcher

  function matcherFor() {
    const rules = readRules(config)
    if (rules !== compiledSource) {
      compiledSource = rules
      compiledMatcher = createMatcher(rules, matcherOptions)
      trace('rules', { count: rules.length })
    }
    return compiledMatcher
  }

  // This plugin owns a configuration page (the `plugins.row.config` client
  // cell), so tell the settings service not to project a second, automatic form
  // for the same entry. This is an optional service and a failure here must
  // never affect the shell decorator.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      const settings = scope.settings
      if (settings === undefined || typeof settings.configure !== 'function' || ctx.fiber === undefined) return
      scope.effect(() => {
        try {
          return settings.configure({ auto: false }, ctx.fiber)
        } catch (error) {
          ctx.logger.warn(`[auto-approval] settings.configure skipped: ${String(error)}`)
          return () => {}
        }
      })
    })
  }

  // The injected form the shipped plugins use; it also re-runs if the executor
  // instance is replaced.
  ctx.inject(['shell'], (scope) => {
    scope.effect(() => {
      const shell = scope.shell
      if (shell === undefined || typeof shell.resolve !== 'function') {
        trace('decorate-skipped', { reason: 'no shell.resolve' })
        ctx.logger.error('[auto-approval] ctx.shell.resolve is missing; nothing to decorate')
        return () => {}
      }

      // Flatten any earlier generation of this same plugin back to the original.
      const base = shell.resolve[ORIGINAL] ?? shell.resolve

      const patched = function resolve(request) {
        const spec = base.call(this, request)
        try {
          const policy = spec?.sandboxPolicy
          if (policy === undefined) return spec

          trace('resolve-in', {
            command: String(request?.command ?? '').slice(0, 120),
            mode: policy.mode,
            root: policy.workspaceRoot,
          })

          // Never narrow an explicit full-access call, and never widen read-only
          // unless the operator asked for it.
          if (policy.mode === 'danger-full-access') return spec
          if (policy.mode === 'read-only' && !upgradeFromReadOnly) return spec

          const decision = matcherFor()(request?.command ?? '', {
            workspaceRoot: policy.workspaceRoot,
            workdir: spec.workdir,
          })
          if (decision === undefined) return spec

          // `home` is the one grant that can be applied additively: the
          // provider overlay appends `$HOME` to the shipped writable roots, so
          // the session workspace stays writable. Without the overlay (Windows,
          // or a provider we cannot recognize) the old replace-the-root grant
          // remains the only behavior that works, so keep it as the fallback.
          const { kind, ...grantPolicy } = decision.grant
          const additive = kind === 'home' && overlayState.ready
          const target = additive
            ? `+${grantPolicy.workspaceRoot}`
            : (grantPolicy.workspaceRoot ?? grantPolicy.mode)

          if (audit) {
            const command = String(request?.command ?? '').slice(0, MAX_LOGGED_COMMAND)
            const session = policy.sessionId === undefined ? '' : ` session=${policy.sessionId}`
            trace('grant', { rule: decision.rule, from: policy.workspaceRoot, to: target, additive, command })
            ctx.logger.info(`[auto-approval] rule "${decision.rule}" -> ${target}${session}: ${command}`)
          }
          const sandboxPolicy = additive
            ? {
                ...policy,
                mode: grantPolicy.mode,
                extraWritableRoots: addRoot(policy.extraWritableRoots, grantPolicy.workspaceRoot),
              }
            : { ...policy, ...grantPolicy }
          const granted = { ...spec, sandboxPolicy }
          trace('resolve-out', {
            mode: granted.sandboxPolicy.mode,
            root: granted.sandboxPolicy.workspaceRoot,
            extraRoots: granted.sandboxPolicy.extraWritableRoots,
          })
          return granted
        } catch (error) {
          // A matcher bug must degrade to the normal sandbox + approval path,
          // never to an unconfined run.
          trace('error', { message: String(error) })
          ctx.logger.warn(`[auto-approval] matcher failed, keeping the standing policy: ${String(error)}`)
          return spec
        }
      }

      patched[ORIGINAL] = base
      shell.resolve = patched
      // The service may hand out a fresh wrapper on every read, so an identity
      // check is informational only: `identity: false` with live `grant` lines
      // in the trace means the assignment did reach the target.
      trace('decorated', { identity: shell.resolve === patched })

      return () => {
        if (shell.resolve === patched) shell.resolve = base
      }
    })
  })

  // The provider overlay is what lets a `home` grant keep the session workspace
  // and add `$HOME` as a second writable root. It decorates the live
  // `ctx.sandbox.confine()`, never replaces the provider row: an unsupported
  // runner or a bad argv leaves the shipped confinement untouched.
  installSandboxOverlay(ctx, {
    isSupported: () => process.platform === 'darwin' || process.platform === 'linux',
    onReady: (ready) => {
      overlayState.ready = ready
      trace('overlay-ready', { ready })
    },
    logger: ctx.logger,
    trace,
  })
}
