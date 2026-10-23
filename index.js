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
 * This plugin does not replace `ctx.shell`, register a service, or ship a
 * config schema. A failure here can therefore never leave the composition
 * without a shell — the worst case is "no command is granted".
 *
 * The sandbox governs file *writes* only: reads and network are unrestricted
 * under every mode. So the difference between this grant and `danger-full-access`
 * is "may write under $HOME" versus "may write anywhere, unconfined".
 *
 * @module dsh-whitelist-auto-approval
 */

import { appendFileSync } from 'node:fs'
import { createMatcher } from './matcher.js'

/**
 * Points from an installed wrapper back to the function it wrapped, so a
 * reload flattens the chain instead of stacking another layer. Stacking would
 * make a later layer see an already-granted `workspaceRoot` and mistake the
 * trusted binary for a workspace-supplied one.
 */
const ORIGINAL = Symbol.for('dsh-whitelist-auto-approval.original')

const MAX_LOGGED_COMMAND = 500

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
  const rules = Array.isArray(config.rules) ? config.rules : []
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

  trace('apply', { rules: rules.length, path: process.env.PATH ?? '' })

  const match = createMatcher(rules, {
    extraPath: config.extraPath ?? [],
    onDecision: (info) => trace('decision', info),
    onWarning: (message) => {
      trace('warning', { message })
      ctx.logger.warn(`[auto-approval] ${message}`)
    },
  })

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

          const decision = match(request?.command ?? '', {
            workspaceRoot: policy.workspaceRoot,
            workdir: spec.workdir,
          })
          if (decision === undefined) return spec

          if (audit) {
            const target = decision.grant.workspaceRoot ?? decision.grant.mode
            const command = String(request?.command ?? '').slice(0, MAX_LOGGED_COMMAND)
            const session = policy.sessionId === undefined ? '' : ` session=${policy.sessionId}`
            trace('grant', { rule: decision.rule, from: policy.workspaceRoot, to: target, command })
            ctx.logger.info(`[auto-approval] rule "${decision.rule}" -> ${target}${session}: ${command}`)
          }
          const granted = { ...spec, sandboxPolicy: { ...policy, ...decision.grant } }
          trace('resolve-out', { mode: granted.sandboxPolicy.mode, root: granted.sandboxPolicy.workspaceRoot })
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
}
