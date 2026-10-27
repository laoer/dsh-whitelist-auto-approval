/**
 * Host Config schema for the whitelist plugin.
 *
 * The schema is here for two reasons:
 *
 * 1. Cordis validates the row's `config` against it at load time, so a
 *    structurally broken config fails the row instead of reaching the matcher
 *    with values of the wrong shape.
 * 2. The Web settings surface only projects fields marked `.volatile()`. The
 *    `rules` array is the one field the UI manages, and marking it volatile is
 *    what makes a saved rule change update the running plugin in place instead
 *    of remounting it.
 *
 * The rule entries themselves stay `any`: the matcher already drops a rule it
 * cannot understand (with a warning), and the UI validates every field it
 * writes. Making individual rules strict here would turn one stale YAML entry
 * into a failed plugin row and take the management page down with it.
 *
 * The schema comes from a vendored copy of `@deepseek-ai/schemastery`; see
 * `vendor/README.md` for why this bundle cannot resolve it from the profile.
 *
 * @module dsh-whitelist-auto-approval/schema
 */

import Schema from './vendor/schemastery/index.mjs'

export { Schema }

export const Config = Schema.object({
  audit: Schema.boolean()
    .default(true)
    .description('Write one Host log line for every granted command.'),
  upgradeFromReadOnly: Schema.boolean()
    .default(false)
    .description('Also grant rules when the session policy is read-only.'),
  extraPath: Schema.array(Schema.string())
    .default([])
    .description('Extra PATH entries used when resolving a bare command name.'),
  allowCdPrefix: Schema.boolean()
    .default(true)
    .description('Accept one leading "cd <dir> &&" before an allow-listed command; set false for the strict reading.'),
  promptHint: Schema.boolean()
    .default(true)
    .description('Tell the model which commands and command shapes are auto-approved, in the system prompt.'),
  trace: Schema.string()
    .description('Optional JSONL trace file for diagnosing rule decisions.'),
  rules: Schema.array(Schema.any())
    .default([])
    .description('Ordered per-command sandbox allow-list; entries are validated by the matcher.')
    .volatile(),
})
