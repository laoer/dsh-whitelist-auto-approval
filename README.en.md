# dsh-whitelist-auto-approval

[简体中文](./README.md) | English

A **per-command allow-list** for DSH's bash sandbox: commands such as `lark-cli` or `gh` — which must write under your home directory — stop triggering `danger-full-access` approval prompts, **without** switching the whole session to full access.

```
writes only inside the workspace?      → this plugin is unnecessary (already allowed)
writes ~/.xxx or ~/Library?            → add it to the allow-list; the kernel sandbox still applies
everything else                        → unchanged behaviour, prompts as before
```

## The problem

DSH's `workspace-write` sandbox only allows writes to the session workspace, `/tmp`, and the platform temp directory.

`lark-cli` refreshes its token under `~/Library/Application Support/lark-cli/` and keeps caches, locks and logs under `~/.lark-cli/`. Both are outside the workspace, so the command is denied, the model retries with `sandbox_permissions: danger-full-access`, and you get an approval prompt every time — or you give up file isolation for the entire session.

This plugin replaces that first denial with a wider *write scope for that one call*: `workspace-write` with `$HOME` as the writable root.

## How it works

Every bash call asks `ctx.shell.resolve(request)` for its `sandboxPolicy`. The plugin decorates that method inside `ctx.inject(['shell'])`:

```
tool-bash ──resolve(request)──▶ original resolve()   // workdir / timeout / policy
                                ├─ match the command
                                ├─ hit    → sandboxPolicy = { mode: 'workspace-write', workspaceRoot: '$HOME' }
                                └─ no hit → returned unchanged
                              └─ execute() stays with the shipped executor
```

Design choices:

- **It does not replace `ctx.shell`.** The worst case is "no rule matched" — bash keeps working.
- **Only the write scope changes.** Approval policy, filesystem tools and the session mode are untouched.
- **Fail safe.** Unknown syntax, invalid config or a bad regex falls back to the normal sandbox and approval path. Mistakes cost extra prompts, never extra permission.

## Matching

The model hands over a whole shell string, so the plugin only accepts *one simple command*:

- accepts quoting, escapes and ordinary arguments;
- rejects `;` `&` `|` `<` `>` `(` `)` `{` `}` `` ` `` `$` `!`, newlines, `$`/backticks inside double quotes, and unterminated quotes;
- `argv[0]` must be a bare command name or an absolute path written in the config — `./lark-cli` is not matched;
- the executable is resolved through `PATH` and `realpath`, and a binary inside the session workspace, `/tmp` or the temp directory is refused (that is the only way a model could shadow the name from the repository).

## Install

Requirements: DSH Desktop (profile-based), macOS or Linux, bash path.

```text
plugin_manager(action="install_bundle", target="https://github.com/laoer/dsh-whitelist-auto-approval.git")
```

Or use **Add plugin** on the Plugins page with the same address, or install from a local directory. If the bundle does not show up, fully quit and reopen DSH.

## Configuration

The default allow-list is `lark-cli` and `gh`. To change it, override the row in your profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`). Note that an override replaces the whole `config` — restate every field you need:

```yaml
- id: bash-sandbox-auto-approval
  config:
    audit: true
    upgradeFromReadOnly: false
    extraPath: []
    rules:
      - { name: lark-cli, command: lark-cli, grant: home }
      - { name: gh, command: gh, grant: home, deny: ['\bapi\b.*--method\s+DELETE'] }
      - { name: my-tool, command: /opt/homebrew/bin/my-tool, grant: custom, root: ~/.my-tool }
```

| Field | Required | Meaning |
|---|---|---|
| `command` | yes | bare command name, or an absolute path |
| `name` | no | label used in logs (defaults to `command`) |
| `grant` | no | `home` (default) / `custom` / `full` |
| `root` | for `custom` | writable root, absolute or `~/...` |
| `deny` | no | regexes over the raw command line; any match cancels the grant |
| `allow` | no | regexes; when non-empty at least one must match |

| `grant` | Actual policy | Use for |
|---|---|---|
| `home` | `workspace-write`, writable root `$HOME` | CLIs that write their own state in your home (recommended) |
| `custom` | `workspace-write`, writable root `root` | tighten to a single directory |
| `full` | `danger-full-access` | genuinely unconstrained work (automates the full-access approval) |

Restart DSH after editing the config.

## Verify

Run each line **on its own** (a compound command is never granted):

```bash
lark-cli task +get-my-tasks      # succeeds, no approval prompt
gh api user --jq .login          # prints your login
touch ~/whitelist-probe          # still denied: file access denied under workspace-write
```

The last line is the control: the plugin widens the allow-list, not the session.

## Security

1. **The sandbox never restricted reads or the network.** Under `workspace-write` any command can already read `~/.ssh` or the tokens in `~/.lark-cli`. This plugin adds write capability, not read isolation.
2. **`home` means the whole home directory is writable**, including `~/.zshrc`, `~/Library/LaunchAgents/` and `~/.ssh/authorized_keys` — a persistence risk against a prompt-injected model.
3. **The allow-list trusts the entire program**, including its own download/export subcommands. Use `deny` to exclude the dangerous ones.
4. **`full` automates the full-access approval.** Use it deliberately.
5. **Aliases and wrappers are not matched** (`alias`, `env`, `timeout`, `npx …`), by design.
6. It only answers *"may this command's sandbox be widened"*, never *"should this command run"*.

## Limitations

- **One writable root.** `home` replaces `workspaceRoot`, so a matched command loses write access to the session workspace. Only matters when the workspace lives outside `$HOME`.
- **bash only.** Windows uses `pwsh-sandbox`; the row is disabled there.
- **Depends on `ctx.shell.resolve()`.** A future DSH release that changes the executor contract degrades the plugin to "no grants" — it does not break execution.
- **No graphical configuration.** Rules live in YAML; the bundle can still be toggled on the Plugins page.

## Development

```bash
node --test "test/*.test.mjs"
```

## License

[MIT](./LICENSE)
