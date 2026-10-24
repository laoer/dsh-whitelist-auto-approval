/**
 * Web client half of dsh-whitelist-auto-approval.
 *
 * Registers one configuration cell for this bundle's single row:
 *
 *   plugins.row.config → key "dsh-whitelist-auto-approval#bash-sandbox-auto-approval"
 *
 * The Plugins page renders that cell on the row's configuration page and hands
 * it the Host-owned `form` (a settings snapshot plus `mutate`). The UI edits the
 * ordered `rules` array and saves it with one atomic path operation; the Host
 * persists it in the profile patch and the running plugin picks it up through
 * its volatile rules reference.
 *
 * No Harness Client package is imported. Only React (provided by the module
 * table) and the plain `ctx` services declared in `inject` are used, so a
 * future Host/Client package rename cannot break this bundle.
 */

window.__ModuleLoader__.load({
  id: 'dsh-whitelist-auto-approval',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PACKAGE = 'dsh-whitelist-auto-approval'
    const ROW_ID = 'bash-sandbox-auto-approval'
    const UI_KEY = `${PACKAGE}#${ROW_ID}`
    const NS = 'dsh-whitelist-auto-approval.ui'
    const GRANTS = ['home', 'custom', 'full']

    const zh = {
      summary: '按命令配置的沙箱白名单',
      nav: '命令自动放行',
      title: '白名单规则',
      intro: '命中的命令按放宽后的可写根运行；未命中的命令保持会话自己的沙箱策略与审批。',
      loading: '正在读取配置…',
      unavailable: '配置暂不可用：正在加载，或插件已禁用 / 加载失败。',
      readOnly: '当前 profile 的配置是只读的，无法在这里修改。',
      addRule: '添加规则',
      editRule: '编辑规则',
      newRule: '新规则',
      emptyTitle: '还没有规则',
      emptyBody: '没有规则时，所有命令都按会话原本的沙箱与审批运行。',
      tableCommand: '命令',
      tableAccess: '访问范围',
      tableFilters: '过滤',
      tableActions: '操作',
      commandLabel: '命令',
      commandHint: '裸命令名（经 PATH 解析）或绝对路径；不支持 shell 表达式。',
      commandEmpty: '（空）',
      nameLabel: '标签',
      nameHint: '可选，仅用于日志与列表显示。',
      grantLabel: '授权范围',
      grantHome: 'Home',
      grantHomeDesc: '可写整个用户目录，并保留工作区可写（macOS/Linux）；Windows 上只放宽到用户目录。',
      grantCustom: '指定目录',
      grantCustomDesc: '只放宽到指定的可写根。',
      grantFull: '完全访问',
      grantFullDesc: '移除沙箱限制；慎用。',
      grantInvalid: '未知授权：{grant}',
      fullWarning: '这会移除沙箱对文件写入的限制，只对确实需要完全权限的命令使用。',
      fullAck: '我明白 full 会移除沙箱限制',
      rootLabel: '可写根',
      rootHint: '绝对路径，或以 ~/ 开头。',
      denyLabel: 'deny 正则',
      denyHint: '每行一个；任一命中即不放行。',
      allowLabel: 'allow 正则',
      allowHint: '每行一个；非空时必须命中其一。',
      filtersLabel: '过滤（可选）',
      filtersSummary: 'deny {deny} · allow {allow}',
      none: '—',
      save: '保存',
      applyRule: '确定修改',
      addToList: '添加到列表',
      savingLabel: '保存中…',
      cancel: '取消',
      reset: '重置',
      reload: '重新加载',
      edit: '编辑',
      delete: '删除',
      statusClean: '没有未保存的修改',
      statusDirty: '有未保存的修改',
      statusSaved: '已保存；对新的 bash 调用生效',
      statusFailed: '保存失败；请检查输入后重试',
      statusConflict: 'Host 拒绝了修改（配置可能已在别处变化）。你的草稿还在；可重新加载后重试。',
      statusInvalid: '请先修正标红的规则',
      statusEditing: '正在编辑规则；确认后再点保存',
      statusSaving: '正在保存…',
      hintApplies: '保存写入 profile 的 cordis.patch.yml，并对后续 bash 调用立即生效，无需重启。',
      hintAdvanced: 'audit、extraPath、trace 等高级项仍在 profile patch 的配置里。',
      errorNotObject: '规则不是对象，无法直接编辑；请删除后重新添加。',
      errorBadShape: '规则的字段类型不正确；请在编辑器中修正。',
      errorCommandRequired: '命令不能为空。',
      errorCommandSpace: '命令不能包含空白字符。',
      errorCommandPath: '路径形式的命令必须以 / 或 ~/ 开头。',
      errorGrantInvalid: '授权范围必须是 home、custom 或 full。',
      errorRootRequired: 'custom 授权需要可写根。',
      errorRootInvalid: '可写根必须是绝对路径或以 ~/ 开头。',
      errorDenyInvalid: 'deny 正则无效：{pattern}',
      errorAllowInvalid: 'allow 正则无效：{pattern}',
      errorDuplicate: '已经有规则使用命令 {command}；UI 不允许重复（YAML 仍可手写）。',
      errorFullAck: '勾选确认后才能保存 full 规则。',
    }

    const en = {
      summary: 'Per-command sandbox allow-list',
      nav: 'Command Auto-Approval',
      title: 'Allow-list rules',
      intro: 'Matching commands run with a widened writable root; every other command keeps the session sandbox and approval flow.',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is unavailable: it is still loading, or the plugin is disabled / failed to load.',
      readOnly: 'This profile configuration is read-only, so rules cannot be changed here.',
      addRule: 'Add rule',
      editRule: 'Edit rule',
      newRule: 'New rule',
      emptyTitle: 'No rules yet',
      emptyBody: 'With no rules, every command keeps the session sandbox and approval flow.',
      tableCommand: 'Command',
      tableAccess: 'Access',
      tableFilters: 'Filters',
      tableActions: 'Actions',
      commandLabel: 'Command',
      commandHint: 'A bare command name (resolved through PATH) or an absolute path; shell expressions are not supported.',
      commandEmpty: '(empty)',
      nameLabel: 'Label',
      nameHint: 'Optional; shown in logs and this list.',
      grantLabel: 'Grant',
      grantHome: 'Home',
      grantHomeDesc: 'May write the whole home directory and keeps the workspace writable (macOS/Linux); on Windows it only widens to the home directory.',
      grantCustom: 'Custom root',
      grantCustomDesc: 'Widens only to the chosen writable root.',
      grantFull: 'Full access',
      grantFullDesc: 'Removes the sandbox; use with care.',
      grantInvalid: 'Unknown grant: {grant}',
      fullWarning: 'This removes the sandbox file-write restriction. Use it only for commands that truly need full access.',
      fullAck: 'I understand full access removes the sandbox',
      rootLabel: 'Writable root',
      rootHint: 'An absolute path, or one starting with ~/.',
      denyLabel: 'deny regex',
      denyHint: 'One per line; any match blocks the grant.',
      allowLabel: 'allow regex',
      allowHint: 'One per line; when non-empty, one must match.',
      filtersLabel: 'Filters (optional)',
      filtersSummary: 'deny {deny} · allow {allow}',
      none: '—',
      save: 'Save',
      applyRule: 'Apply changes',
      addToList: 'Add to list',
      savingLabel: 'Saving…',
      cancel: 'Cancel',
      reset: 'Reset',
      reload: 'Reload',
      edit: 'Edit',
      delete: 'Delete',
      statusClean: 'No unsaved changes',
      statusDirty: 'Unsaved changes',
      statusSaved: 'Saved; applies to new bash calls',
      statusFailed: 'Save failed; check the values and try again',
      statusConflict: 'The Host rejected the change (it may have been edited elsewhere). Your draft is kept; reload to retry from the Host state.',
      statusInvalid: 'Fix the highlighted rules first',
      statusEditing: 'Editing a rule; apply it, then Save',
      statusSaving: 'Saving…',
      hintApplies: 'Saving writes the profile cordis.patch.yml and applies to subsequent bash calls without a restart.',
      hintAdvanced: 'Advanced options such as audit, extraPath and trace stay in the profile patch configuration.',
      errorNotObject: 'This rule is not an object and cannot be edited directly; delete it and add a new one.',
      errorBadShape: 'This rule has fields of the wrong type; fix it in the editor.',
      errorCommandRequired: 'Command is required.',
      errorCommandSpace: 'Command must not contain whitespace.',
      errorCommandPath: 'A path-form command must start with / or ~/.',
      errorGrantInvalid: 'Grant must be home, custom, or full.',
      errorRootRequired: 'A custom grant needs a writable root.',
      errorRootInvalid: 'The writable root must be absolute or start with ~/.',
      errorDenyInvalid: 'Invalid deny regex: {pattern}',
      errorAllowInvalid: 'Invalid allow regex: {pattern}',
      errorDuplicate: 'Another rule already uses {command}; the UI does not allow duplicates (YAML still can).',
      errorFullAck: 'Confirm the full-access warning before saving.',
    }

    let ruleSequence = 0

    function isPlainObject(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const proto = Object.getPrototypeOf(value)
      return proto === Object.prototype || proto === null
    }

    function makeRule(overrides) {
      ruleSequence += 1
      return {
        id: `rule-${ruleSequence}`,
        command: '',
        name: '',
        grant: 'home',
        root: '',
        deny: '',
        allow: '',
        fullAck: false,
        entryProblem: undefined,
        ...overrides,
      }
    }

    /** Split a textarea value into regex sources; returns the first invalid line. */
    function parseRegexLines(text) {
      const lines = String(text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      for (const line of lines) {
        try {
          new RegExp(line)
        } catch {
          return { patterns: lines, invalid: line }
        }
      }
      return { patterns: lines, invalid: undefined }
    }

    /** Build the editable draft from one raw config rule. */
    function fromRule(raw) {
      if (!isPlainObject(raw)) return makeRule({ entryProblem: 'notObject' })
      const shapeOk =
        (raw.command === undefined || typeof raw.command === 'string') &&
        (raw.name === undefined || typeof raw.name === 'string') &&
        (raw.grant === undefined || typeof raw.grant === 'string') &&
        (raw.root === undefined || typeof raw.root === 'string') &&
        (raw.deny === undefined || (Array.isArray(raw.deny) && raw.deny.every((entry) => typeof entry === 'string'))) &&
        (raw.allow === undefined || (Array.isArray(raw.allow) && raw.allow.every((entry) => typeof entry === 'string')))
      const grant = typeof raw.grant === 'string' && raw.grant !== '' ? raw.grant : 'home'
      return makeRule({
        command: typeof raw.command === 'string' ? raw.command : '',
        name: typeof raw.name === 'string' ? raw.name : '',
        grant,
        root: typeof raw.root === 'string' ? raw.root : '',
        deny: Array.isArray(raw.deny) ? raw.deny.filter((entry) => typeof entry === 'string').join('\n') : '',
        allow: Array.isArray(raw.allow) ? raw.allow.filter((entry) => typeof entry === 'string').join('\n') : '',
        fullAck: grant === 'full',
        entryProblem: shapeOk ? undefined : 'badShape',
      })
    }

    function normalizeRules(value) {
      if (!Array.isArray(value)) return []
      return value.map((raw) => fromRule(raw))
    }

    /**
     * Problems for one draft rule. `all` is the complete list; the rule at
     * `index` is excluded from the duplicate check so an edited rule does not
     * collide with itself.
     */
    function validateRule(rule, index, all) {
      const problems = []
      if (rule.entryProblem === 'notObject' || rule.entryProblem === 'badShape') {
        problems.push({ code: rule.entryProblem })
      }
      const command = rule.command.trim()
      if (command === '') {
        problems.push({ code: 'commandRequired', field: 'command' })
      } else if (/\s/.test(command)) {
        problems.push({ code: 'commandSpace', field: 'command' })
      } else if (command.includes('/') && !command.startsWith('/') && !command.startsWith('~/')) {
        problems.push({ code: 'commandPath', field: 'command' })
      }
      if (!GRANTS.includes(rule.grant)) problems.push({ code: 'grantInvalid', field: 'grant' })
      const root = rule.root.trim()
      if (rule.grant === 'custom') {
        if (root === '') problems.push({ code: 'rootRequired', field: 'root' })
        else if (!root.startsWith('/') && !root.startsWith('~/')) problems.push({ code: 'rootInvalid', field: 'root' })
      }
      const deny = parseRegexLines(rule.deny)
      if (deny.invalid !== undefined) problems.push({ code: 'denyInvalid', field: 'deny', detail: deny.invalid })
      const allow = parseRegexLines(rule.allow)
      if (allow.invalid !== undefined) problems.push({ code: 'allowInvalid', field: 'allow', detail: allow.invalid })
      if (
        command !== '' &&
        all.some((other, otherIndex) => otherIndex !== index && other.command.trim() === command)
      ) {
        problems.push({ code: 'duplicate', field: 'command', detail: command })
      }
      if (rule.grant === 'full' && rule.fullAck !== true) problems.push({ code: 'fullAck', field: 'fullAck' })
      return problems
    }

    /** Convert the editable draft back into the config shape stored on the Host. */
    function toConfigRules(rules) {
      return rules.map((rule) => {
        const entry = { command: rule.command.trim() }
        const name = rule.name.trim()
        if (name !== '') entry.name = name
        if (rule.grant !== 'home') entry.grant = rule.grant
        if (rule.grant === 'custom') {
          const root = rule.root.trim()
          if (root !== '') entry.root = root
        }
        const deny = parseRegexLines(rule.deny).patterns
        if (deny.length > 0) entry.deny = deny
        const allow = parseRegexLines(rule.allow).patterns
        if (allow.length > 0) entry.allow = allow
        return entry
      })
    }

    function ruleShape(rule) {
      return [rule.command.trim(), rule.name.trim(), rule.grant, rule.root.trim(), rule.deny, rule.allow]
    }

    function rulesEqual(left, right) {
      if (left.length !== right.length) return false
      return left.every((rule, index) => JSON.stringify(ruleShape(rule)) === JSON.stringify(ruleShape(right[index])))
    }

    function grantLabel(t, grant) {
      if (grant === 'home') return t('grantHome')
      if (grant === 'custom') return t('grantCustom')
      if (grant === 'full') return t('grantFull')
      return t('grantInvalid', { grant })
    }

    function grantDescription(t, grant) {
      if (grant === 'home') return t('grantHomeDesc')
      if (grant === 'custom') return t('grantCustomDesc')
      if (grant === 'full') return t('grantFullDesc')
      return ''
    }

    function problemText(t, problem) {
      switch (problem.code) {
        case 'notObject':
          return t('errorNotObject')
        case 'badShape':
          return t('errorBadShape')
        case 'commandRequired':
          return t('errorCommandRequired')
        case 'commandSpace':
          return t('errorCommandSpace')
        case 'commandPath':
          return t('errorCommandPath')
        case 'grantInvalid':
          return t('errorGrantInvalid')
        case 'rootRequired':
          return t('errorRootRequired')
        case 'rootInvalid':
          return t('errorRootInvalid')
        case 'denyInvalid':
          return t('errorDenyInvalid', { pattern: problem.detail })
        case 'allowInvalid':
          return t('errorAllowInvalid', { pattern: problem.detail })
        case 'duplicate':
          return t('errorDuplicate', { command: problem.detail })
        case 'fullAck':
          return t('errorFullAck')
        default:
          return problem.code
      }
    }

    const CSS = `
.dwa { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.dwa-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dwa-title { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.dwa-intro { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); max-width: 640px; }
.dwa-banner { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 18px; }
.dwa-banner[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary); }
.dwa-banner[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dwa-banner[data-tone="ok"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dwa-tableWrap { overflow-x: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
.dwa-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dwa-table th { padding: 8px 10px; text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.dwa-table td { padding: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.dwa-table tr:last-child td { border-bottom: 0; }
.dwa-command { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; word-break: break-all; }
.dwa-sub { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; word-break: break-all; }
.dwa-problem { margin-top: 5px; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 16px; }
.dwa-badge { display: inline-flex; align-items: center; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 18px; white-space: nowrap; }
.dwa-badge[data-grant="home"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dwa-badge[data-grant="custom"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dwa-badge[data-grant="full"], .dwa-badge[data-grant="invalid"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dwa-actions { display: flex; gap: 6px; }
.dwa-button { font: inherit; font-size: 12px; line-height: 18px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dwa-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dwa-button:disabled { opacity: .5; cursor: default; }
.dwa-button[data-variant="primary"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dwa-button[data-variant="danger"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dwa-button[data-size="sm"] { padding: 2px 8px; font-size: 11px; }
.dwa-form { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 12px; }
.dwa-formHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dwa-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.dwa-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.dwa-field > span:first-child { color: var(--dsw-alias-label-secondary); }
.dwa-input, .dwa-select, .dwa-textarea { box-sizing: border-box; width: 100%; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 5px 8px; }
.dwa-textarea { min-height: 54px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
.dwa-input:focus-visible, .dwa-select:focus-visible, .dwa-textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dwa-help { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.dwa-errors { margin: 0; padding-left: 18px; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.dwa-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dwa-footerActions { display: flex; align-items: center; gap: 6px; }
.dwa-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dwa-status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dwa-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dwa-status[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dwa-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 18px; text-align: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dwa-empty strong { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-primary); }
.dwa-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 18px; }
.dwa-check input { margin: 2px 0 0; }
`

    function MessagePage({ t, text }) {
      return h('section', { className: 'dwa' }, h('style', null, CSS), h('p', { className: 'dwa-intro' }, text))
    }

    function RuleTable({ rules, problems, t, disabled, onEdit, onDelete }) {
      if (rules.length === 0) {
        return h(
          'div',
          { className: 'dwa-empty' },
          h('strong', null, t('emptyTitle')),
          t('emptyBody'),
        )
      }
      return h(
        'div',
        { className: 'dwa-tableWrap' },
        h(
          'table',
          { className: 'dwa-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, t('tableCommand')),
              h('th', null, t('tableAccess')),
              h('th', null, t('tableFilters')),
              h('th', null, t('tableActions')),
            ),
          ),
          h(
            'tbody',
            null,
            rules.map((rule, index) => {
              const rowProblems = problems[index] ?? []
              const deny = parseRegexLines(rule.deny).patterns.length
              const allow = parseRegexLines(rule.allow).patterns.length
              const grant = GRANTS.includes(rule.grant) ? rule.grant : 'invalid'
              return h(
                'tr',
                { key: rule.id },
                h(
                  'td',
                  null,
                  h('code', { className: 'dwa-command' }, rule.command.trim() || t('commandEmpty')),
                  rule.name.trim() === '' ? null : h('div', { className: 'dwa-sub' }, rule.name.trim()),
                  rowProblems.length === 0
                    ? null
                    : h(
                        'div',
                        { className: 'dwa-problem' },
                        rowProblems.map((problem, problemIndex) => h('div', { key: `${problem.code}-${problemIndex}` }, problemText(t, problem))),
                      ),
                ),
                h(
                  'td',
                  null,
                  h('span', { className: 'dwa-badge', 'data-grant': grant }, grantLabel(t, rule.grant)),
                  rule.grant === 'custom' && rule.root.trim() !== ''
                    ? h('div', { className: 'dwa-sub' }, h('code', null, rule.root.trim()))
                    : null,
                  h('div', { className: 'dwa-sub' }, grantDescription(t, rule.grant)),
                ),
                h(
                  'td',
                  null,
                  deny === 0 && allow === 0
                    ? h('span', { className: 'dwa-sub' }, t('none'))
                    : h('span', { className: 'dwa-sub' }, t('filtersSummary', { deny, allow })),
                ),
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { className: 'dwa-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dwa-button',
                        'data-size': 'sm',
                        disabled,
                        onClick: () => onEdit(index),
                      },
                      t('edit'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dwa-button',
                        'data-size': 'sm',
                        'data-variant': 'danger',
                        disabled,
                        onClick: () => onDelete(index),
                      },
                      t('delete'),
                    ),
                  ),
                ),
              )
            }),
          ),
        ),
      )
    }

    function RuleEditor({ initial, index, all, t, onSave, onCancel }) {
      const [value, setValue] = React.useState(() => ({
        ...initial,
        entryProblem: undefined,
        fullAck: initial.fullAck === true,
      }))
      const problems = validateRule(value, index === null ? all.length : index, all)
      const update = (patch) => setValue((current) => ({ ...current, ...patch }))
      const invalid = (field) => problems.some((problem) => problem.field === field)
      const submit = (event) => {
        event.preventDefault()
        if (problems.length === 0) onSave(value)
      }

      return h(
        'form',
        {
          className: 'dwa-form',
          onSubmit: submit,
          'aria-label': t(index === null ? 'newRule' : 'editRule'),
        },
        h('div', { className: 'dwa-formHead' }, h('strong', null, t(index === null ? 'newRule' : 'editRule'))),
        problems.length === 0
          ? null
          : h(
              'ul',
              { className: 'dwa-errors', role: 'alert' },
              problems.map((problem, problemIndex) =>
                h('li', { key: `${problem.code}-${problemIndex}` }, problemText(t, problem)),
              ),
            ),
        h(
          'label',
          { className: 'dwa-field' },
          h('span', null, t('commandLabel')),
          h('input', {
            className: 'dwa-input',
            value: value.command,
            autoFocus: true,
            spellCheck: false,
            'aria-invalid': invalid('command') || undefined,
            onChange: (event) => update({ command: event.target.value }),
          }),
          h('span', { className: 'dwa-help' }, t('commandHint')),
        ),
        h(
          'label',
          { className: 'dwa-field' },
          h('span', null, t('nameLabel')),
          h('input', {
            className: 'dwa-input',
            value: value.name,
            spellCheck: false,
            onChange: (event) => update({ name: event.target.value }),
          }),
          h('span', { className: 'dwa-help' }, t('nameHint')),
        ),
        h(
          'label',
          { className: 'dwa-field' },
          h('span', null, t('grantLabel')),
          h(
            'select',
            {
              className: 'dwa-select',
              value: value.grant,
              'aria-invalid': invalid('grant') || undefined,
              onChange: (event) => update({ grant: event.target.value, fullAck: false }),
            },
            GRANTS.includes(value.grant)
              ? null
              : h('option', { value: value.grant, disabled: true }, t('grantInvalid', { grant: value.grant })),
            h('option', { value: 'home' }, t('grantHome')),
            h('option', { value: 'custom' }, t('grantCustom')),
            h('option', { value: 'full' }, t('grantFull')),
          ),
          h('span', { className: 'dwa-help' }, grantDescription(t, value.grant)),
        ),
        value.grant === 'custom'
          ? h(
              'label',
              { className: 'dwa-field' },
              h('span', null, t('rootLabel')),
              h('input', {
                className: 'dwa-input',
                value: value.root,
                spellCheck: false,
                'aria-invalid': invalid('root') || undefined,
                onChange: (event) => update({ root: event.target.value }),
              }),
              h('span', { className: 'dwa-help' }, t('rootHint')),
            )
          : null,
        h(
          'div',
          { className: 'dwa-field' },
          h('span', null, t('filtersLabel')),
          h(
            'div',
            { className: 'dwa-grid' },
            h(
              'label',
              { className: 'dwa-field' },
              h('span', null, t('denyLabel')),
              h('textarea', {
                className: 'dwa-textarea',
                value: value.deny,
                spellCheck: false,
                'aria-invalid': invalid('deny') || undefined,
                onChange: (event) => update({ deny: event.target.value }),
              }),
              h('span', { className: 'dwa-help' }, t('denyHint')),
            ),
            h(
              'label',
              { className: 'dwa-field' },
              h('span', null, t('allowLabel')),
              h('textarea', {
                className: 'dwa-textarea',
                value: value.allow,
                spellCheck: false,
                'aria-invalid': invalid('allow') || undefined,
                onChange: (event) => update({ allow: event.target.value }),
              }),
              h('span', { className: 'dwa-help' }, t('allowHint')),
            ),
          ),
        ),
        value.grant === 'full'
          ? h(
              'div',
              { className: 'dwa-banner', 'data-tone': 'warn' },
              h(
                'div',
                null,
                h('div', null, t('fullWarning')),
                h(
                  'label',
                  { className: 'dwa-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: value.fullAck === true,
                    'aria-invalid': invalid('fullAck') || undefined,
                    onChange: (event) => update({ fullAck: event.target.checked }),
                  }),
                  h('span', null, t('fullAck')),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dwa-footerActions' },
          h('button', { type: 'button', className: 'dwa-button', onClick: onCancel }, t('cancel')),
          h('button', { type: 'submit', className: 'dwa-button', 'data-variant': 'primary', disabled: problems.length > 0 }, t(index === null ? 'addToList' : 'applyRule')),
        ),
      )
    }

    function RulePage({ form, t, locale }) {
      const [, bumpLocale] = React.useReducer((value) => value + 1, 0)
      React.useEffect(
        () => (locale && typeof locale.subscribe === 'function' ? locale.subscribe(bumpLocale) : undefined),
        [locale],
      )

      const state = form?.state
      const ready = state?.status === 'ready' && state?.value !== undefined
      const writable = state?.writable !== false
      const revision = ready ? state.revision : undefined
      const baseline = React.useMemo(
        () => normalizeRules(ready ? state.value?.rules : []),
        [ready, revision, state?.value],
      )
      const [draft, setDraft] = React.useState(baseline)
      const [editing, setEditing] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const previousBaseline = React.useRef(baseline)

      // Follow Host updates while the draft is clean; keep unsaved edits.
      React.useEffect(() => {
        const previous = previousBaseline.current
        previousBaseline.current = baseline
        if (previous === baseline) return
        setDraft((current) => (rulesEqual(current, previous) ? baseline : current))
      }, [baseline])

      const problems = React.useMemo(
        () => draft.map((rule, index) => validateRule(rule, index, draft)),
        [draft],
      )
      const dirty = !rulesEqual(draft, baseline)
      const invalid = problems.some((list) => list.length > 0)

      if (form === undefined) return h(MessagePage, { t, text: t('unavailable') })
      if (state?.status === 'unavailable') return h(MessagePage, { t, text: t('unavailable') })
      if (state?.status !== 'ready' || state?.value === undefined) return h(MessagePage, { t, text: t('loading') })

      const openEditor = (index, rule) => {
        setEditing({ index, rule })
        setNotice(null)
      }
      const commitEditor = (rule) => {
        const cleaned = { ...rule, entryProblem: undefined, fullAck: rule.grant === 'full' }
        const next =
          editing.index === null
            ? [...draft, cleaned]
            : draft.map((item, index) => (index === editing.index ? cleaned : item))
        setDraft(next)
        setEditing(null)
        setNotice(null)
      }
      const reset = () => {
        setDraft(baseline)
        setEditing(null)
        setNotice(null)
      }
      const save = async () => {
        if (form === undefined || !ready || !writable || saving || editing !== null || invalid || !dirty) return
        setSaving(true)
        setNotice(null)
        try {
          const next = toConfigRules(draft)
          const ok = await form.mutate(
            [{ op: 'set', path: ['rules'], value: next }],
            state.revision,
          )
          if (ok) {
            setDraft(normalizeRules(next))
            setEditing(null)
            setNotice({ tone: 'ok', text: t('statusSaved') })
          } else {
            setNotice({ tone: 'error', text: t('statusConflict'), reload: true })
          }
        } catch {
          setNotice({ tone: 'error', text: t('statusFailed') })
        } finally {
          setSaving(false)
        }
      }

      const statusText = saving
        ? t('statusSaving')
        : notice !== null
          ? notice.text
          : editing !== null
            ? t('statusEditing')
            : invalid
              ? t('statusInvalid')
              : dirty
                ? t('statusDirty')
                : t('statusClean')
      const statusTone = saving ? undefined : notice?.tone ?? (invalid ? 'error' : dirty ? 'warn' : undefined)

      return h(
        'section',
        { className: 'dwa' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dwa-head' },
          h(
            'div',
            null,
            h('h3', { className: 'dwa-title' }, t('title')),
            h('p', { className: 'dwa-intro' }, t('intro')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dwa-button',
              'data-variant': 'primary',
              disabled: !writable || saving || editing !== null,
              onClick: () => openEditor(null, makeRule()),
            },
            t('addRule'),
          ),
        ),
        writable ? null : h('div', { className: 'dwa-banner', 'data-tone': 'warn' }, t('readOnly')),
        editing === null
          ? null
          : h(RuleEditor, {
              key: editing.index === null ? 'new' : `edit-${editing.index}`,
              initial: editing.rule,
              index: editing.index,
              all: draft,
              t,
              onSave: commitEditor,
              onCancel: () => setEditing(null),
            }),
        h(RuleTable, {
          rules: draft,
          problems,
          t,
          disabled: !writable || saving || editing !== null,
          onEdit: (index) => openEditor(index, { ...draft[index], entryProblem: undefined }),
          onDelete: (index) => {
            setDraft(draft.filter((_, itemIndex) => itemIndex !== index))
            if (editing !== null && editing.index === index) setEditing(null)
            setNotice(null)
          },
        }),
        h(
          'div',
          { className: 'dwa-footer' },
          h(
            'div',
            null,
            h('div', { className: 'dwa-status', 'data-tone': statusTone, role: 'status' }, statusText),
            h('div', { className: 'dwa-help' }, t('hintApplies')),
            h('div', { className: 'dwa-help' }, t('hintAdvanced')),
          ),
          h(
            'div',
            { className: 'dwa-footerActions' },
            notice?.reload === true
              ? h('button', { type: 'button', className: 'dwa-button', onClick: reset }, t('reload'))
              : null,
            h('button', { type: 'button', className: 'dwa-button', disabled: !dirty || saving, onClick: reset }, t('reset')),
            h(
              'button',
              {
                type: 'button',
                className: 'dwa-button',
                'data-variant': 'primary',
                disabled: !writable || saving || editing !== null || invalid || !dirty,
                onClick: save,
              },
              saving ? t('savingLabel') : t('save'),
            ),
          ),
        ),
      )
    }

    function RuleConfigView({ view, form, t, locale }) {
      if (view === 'summary') return h('span', null, t('summary'))
      return h(RulePage, { form, t, locale })
    }

    /**
     * Dedicated Settings page. The settings shell does not pass a `form` prop
     * to a section, so this reads the same shared config form controller that
     * the Plugins row page uses. Both surfaces therefore edit the same
     * Host-owned namespace.
     */
    function SettingsSection({ controller, t, locale }) {
      const [state, setState] = React.useState(() => controller.getSnapshot())
      React.useEffect(() => {
        setState(controller.getSnapshot())
        return controller.subscribe(() => setState(controller.getSnapshot()))
      }, [controller])

      return h(RulePage, {
        form: {
          state,
          mutate: (ops, revision) => controller.mutate(ops, revision),
        },
        t,
        locale,
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-approval: ui dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: UI_KEY },
            (props) => h(RuleConfigView, { ...props, t, locale: ctx.locale }),
          ),
        )

        // A dedicated left-nav page in Settings. `configForms` is optional: if
        // the deployment has no settings client, the Plugins row page still
        // works and this section simply does not appear. The row id is the
        // settings namespace, so both surfaces share one controller.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], (scope) => {
            if (scope.configForms === undefined) return
            const controller = scope.configForms.get(ROW_ID)
            scope.effect(() =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: 'auto-approval',
                    order: 110,
                    label: () => t('nav'),
                  },
                  (props) =>
                    h(SettingsSection, {
                      ...props,
                      t,
                      locale: ctx.locale,
                      controller,
                    }),
                ),
              ),
            )
          })
        }
      },
      __test: {
        UI_KEY,
        PACKAGE,
        ROW_ID,
        GRANTS,
        dicts: { zh, en },
        parseRegexLines,
        fromRule,
        normalizeRules,
        validateRule,
        toConfigRules,
        rulesEqual,
        grantLabel,
        grantDescription,
        RuleTable,
        RuleEditor,
        RulePage,
        RuleConfigView,
        SettingsSection,
      },
    }
  },
})
