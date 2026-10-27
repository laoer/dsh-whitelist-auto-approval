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
 * spec's per-call `sandboxPolicy` is widened to `workspace-write` with the
 * rule's writable roots appended (`$HOME` by default), so the first attempt
 * already succeeds and the escalation dance never starts. Every other call
 * keeps the standing policy and the normal approval prompt.
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
 * Prompt section this plugin owns. It states the recognized command shapes, so
 * a deployment does not need a per-repository `AGENTS.md` note: the constraint
 * follows the installation instead of the checkout.
 */
const PROMPT_SECTION = 'tool:bash:auto-approval'
/**
 * Fallback placement: `tool:bash` is order 1000 in the prompt registry and
 * `tool:pwsh` is 1010, so the hint sits with the tool it explains.
 */
const PROMPT_ORDER_FALLBACK = 1002

/**
 * The model-facing text for the current rules.
 *
 * It names the granted commands (the part the model cannot guess) and splits
 * them by shape: commands whose calls must use a recognized shape, and
 * commands granted for any shape. It is derived from the live rules on every
 * assembly, so a rule saved in Settings is described on the next model step.
 * This is guidance only: the matcher and the sandbox still decide, and a model
 * that ignores it merely gets the normal approval prompt.
 *
 * @param {object[]} rules resolved rules.
 * @returns {string} one paragraph, or `''` when there is nothing to announce.
 */
function promptText(rules) {
  const strictNames = []
  const anyNames = []
  for (const rule of rules) {
    const declared = String(rule?.command ?? '').trim()
    if (declared === '') continue
    const label = String(rule?.name ?? '').trim() || declared
    const bucket = rule?.shape === 'any' ? anyNames : strictNames
    if (!bucket.includes(label)) bucket.push(label)
  }
  if (strictNames.length === 0 && anyNames.length === 0) return ''

  // Bound the token cost: a long allow-list is summarized instead of pasted.
  const summary = (names) => {
    const shown = names.slice(0, 8)
    const rest = names.length - shown.length
    return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ')
  }

  const parts = []
  if (strictNames.length > 0) {
    parts.push(
      [
        `Auto-approved bash commands on this deployment: ${summary(strictNames)}.`,
        'A call in one of these shapes runs with its extra writable roots outside the workspace instead of an approval prompt: `<command> ...` with the `workdir` argument, or `cd <dir> && <command> ...`.',
        'A trailing `2>&1`, a `>/dev/null` redirect, and a pipe into `tail`, `head`, or `wc` with numeric arguments are accepted too.',
        'Anything else (`> file`, `| tee`, `| sh`, `;`, a second `&&`, `$(...)`) runs under the normal sandbox and its approval prompt.',
      ].join(' '),
    )
  }
  if (anyNames.length > 0) {
    parts.push(
      `Any command line that names ${summary(anyNames)} is granted its configured writable roots whatever the shell syntax; writes stay limited to those roots.`,
    )
  }
  return parts.join(' ')
}

/**
 * Append roots to a policy's additional-root list without duplicating any.
 * Keeps the original array reference when every root is already present, so a
 * repeated grant does not churn the spec.
 */
function addRoots(existing, roots) {
  const kept = Array.isArray(existing) ? existing : []
  const missing = roots.filter((root) => !kept.includes(root))
  return missing.length === 0 ? kept : [...kept, ...missing]
}

/**
 * Decide how one grant is expressed in the policy.
 *
 * POSIX providers carry a list of extra roots, so a widening grant there is
 * always additive: the session workspace keeps its root and the rule's roots
 * are appended. When the overlay is missing those extra roots are simply inert
 * — the command still has the workspace — which is why the target string says
 * so and the caller warns once.
 *
 * Windows ACL policies carry a single root, so a rule with roots replaces it
 * and only the first root survives.
 *
 * @param {{ kind?: string, mode?: string, roots?: string[] }} grant compiled grant.
 * @param {{ overlayReady?: boolean, platform?: string }} state deployment facts.
 * @returns {{ additive: boolean, overlayMissing: boolean, target: string }}
 */
export function resolveGrantShape(grant, state = {}) {
  const roots = Array.isArray(grant?.roots) ? grant.roots : []
  const mode = String(grant?.mode ?? '')
  const platform = state.platform ?? process.platform
  const additive = roots.length > 0 && platform !== 'win32'
  const overlayMissing = additive && state.overlayReady !== true
  const target = additive
    ? `${roots.map((root) => `+${root}`).join(' ')}${overlayMissing ? ' (root overlay inactive)' : ''}`
    : (roots[0] ?? mode)
  return { additive, overlayMissing, target }
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
  /** A missing overlay affects every granted call, so warn once per apply. */
  let warnedMissingOverlay = false
  /** Windows can only express one root; say so once per apply. */
  let warnedMultiRoot = false

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

  // The plugin owns the model-facing hint for its own rules. This is what
  // replaces a per-repository AGENTS.md note: it ships with the installation,
  // follows the live rules, and disappears when the rules are empty. A failure
  // here never affects the shell decorator below.
  if (config.promptHint !== false) {
    ctx.inject(['systemPrompt'], (scope) => {
      const systemPrompt = scope.systemPrompt
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
        trace('prompt-skipped', { reason: 'no systemPrompt.section' })
        return
      }
      scope.effect(() => {
        try {
          const base = typeof systemPrompt.getSectionOrder === 'function' ? systemPrompt.getSectionOrder('TOOL_BASH') : undefined
          return systemPrompt.section({
            name: PROMPT_SECTION,
            order: Number.isFinite(base) ? base + 2 : PROMPT_ORDER_FALLBACK,
            text: () => promptText(readRules(config)),
            // Rule labels are user data: never treat `{{…}}` in them as a variable.
            interpolate: false,
          })
        } catch (error) {
          ctx.logger.warn(`[auto-approval] prompt section skipped: ${String(error)}`)
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

          // On POSIX a widening grant is always expressed additively: the
          // shipped writable roots (the session workspace) stay and the rule's
          // roots are appended. The provider materializes them through the
          // overlay; if that overlay is missing the roots are simply inert.
          //
          // Deliberately never "replace the root" here. A replacement silently
          // drops the session workspace and, with several roots, keeps only the
          // first one — a grant that is both narrower than configured and wider
          // than the workspace, which is exactly the kind of mismatch that looks
          // like a broken CLI instead of a sandbox decision. Windows keeps the
          // replacement because its ACL policy can only carry one root.
          const { kind, mode, roots } = decision.grant
          const { additive, overlayMissing, target } = resolveGrantShape(decision.grant, {
            overlayReady: overlayState.ready,
          })

          if (!additive && roots.length > 1 && !warnedMultiRoot) {
            warnedMultiRoot = true
            trace('multi-root-fallback', { rule: decision.rule, roots })
            ctx.logger.warn(
              `[auto-approval] this sandbox runner cannot express multiple writable roots; only ${roots[0]} is used for rule "${decision.rule}"`,
            )
          }
          if (overlayMissing && !warnedMissingOverlay) {
            warnedMissingOverlay = true
            trace('grant-without-overlay', { rule: decision.rule, roots })
            ctx.logger.warn(
              `[auto-approval] the writable-root overlay is not installed; rule "${decision.rule}" keeps the workspace root but ${roots.length === 1 ? 'its root is' : 'its extra roots are'} not applied`,
            )
          }
          if (audit) {
            const command = String(request?.command ?? '').slice(0, MAX_LOGGED_COMMAND)
            const session = policy.sessionId === undefined ? '' : ` session=${policy.sessionId}`
            trace('grant', {
              rule: decision.rule,
              kind,
              from: policy.workspaceRoot,
              to: target,
              roots,
              additive,
              overlay: overlayState.ready,
              command,
            })
            ctx.logger.info(`[auto-approval] rule "${decision.rule}" -> ${target}${session}: ${command}`)
          }
          const sandboxPolicy = additive
            ? {
                ...policy,
                mode,
                extraWritableRoots: addRoots(policy.extraWritableRoots, roots),
              }
            : roots.length === 0
              ? { ...policy, mode }
              : { ...policy, mode, workspaceRoot: roots[0] }
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
