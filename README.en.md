# dsh-whitelist-auto-approval

[简体中文](./README.md) | English

A **per-command allow-list** for DSH's bash sandbox: commands such as `lark-cli` or `gh` — which must write under your home directory — stop triggering `danger-full-access` approval prompts, **without** switching the whole session to full access.

```
writes only inside the workspace?      → this plugin is unnecessary (already allowed)
writes ~/.xxx or ~/Library?            → add it to the allow-list; the kernel sandbox still applies
everything else                        → unchanged behaviour, prompts as before
```

## How it differs

Several DSH plugins already remove the "writes outside the workspace" prompts. The useful axis is **where the command runs after it is allowed**:

| Approach | Where the allowed command runs | Examples |
|---|---|---|
| **Swap the writable root per command (this plugin)** | inside the kernel sandbox, root = `$HOME` | this plugin |
| Add writable roots to the sandbox | inside the kernel sandbox, extra directories | dsh-write-protect, @morlay/dsh-sandbox-local |
| Command allow-list where `allow` grants escalation | outside the sandbox | dsh-sandbox-allowlist |
| Answer the approval for you | outside the sandbox, `allowed-once` | dsh-dhe-allow, dsh-auto-approval-plugin |

The difference is not how many prompts you skip, but **how much isolation you give up**: the last three either run the command outside the sandbox or add extra writable directories at config level for every command; this plugin's wider root applies only to the matched command, and it matches executables rather than command strings.

That is all it does. If you need deny rules, network policy or per-directory grants, the matching option above is the better fit.

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

### From npm

The package is published on npm:

```text
plugin_manager(action="install_bundle", target="dsh-whitelist-auto-approval")
```

Or use **Add plugin** on the Plugins page with `dsh-whitelist-auto-approval` (optionally `dsh-whitelist-auto-approval@0.2.0`).

To track the latest commit or install from a local checkout, use the GitHub or local-directory option below.

### From GitHub

```text
plugin_manager(action="install_bundle", target="https://github.com/laoer/dsh-whitelist-auto-approval.git")
```

### From a local directory

```text
plugin_manager(action="install_bundle", target="/absolute/path/dsh-whitelist-auto-approval")
```

### Desktop and CLI

- **Desktop**: Plugins → **Add plugin** accepts an npm package name, a Git address, a tarball, or an absolute local path.
- **CLI**: `dsh plugin add dsh-whitelist-auto-approval` (or the Git address) works for CLI-managed profiles. The Desktop profile is application-owned and not exposed to CLI profile lookup; Desktop users should use the Plugins page or `plugin_manager`.

If the bundle does not show up, fully quit and reopen DSH. The first install or update needs one restart so the Web client loads `client.js`; editing rules in the UI afterwards needs no restart.

## Manage the allow-list in the UI (recommended)

After restarting:

1. Open **Settings** (the gear at the bottom-left);
2. choose **Command Auto-Approval** in the left list;
3. add, edit or delete rules on the right, then **Save**.

The same form is also reachable from Plugins: sidebar **Plugins** → **Command Auto-Approval** → click the `bash-sandbox-auto-approval` row title (the `›` chevron).

Saving writes the profile `cordis.patch.yml` and applies to the **next bash call** with no restart. The UI manages the rule table (`command` / `name` / `grant` / `root` / `deny` / `allow`); `audit`, `extraPath` and `trace` stay in the profile patch. Choosing `grant: full` shows a warning and requires an explicit acknowledgement.

Editing the allow-list is always a user action: the plugin registers no agent tool that can change it.

## Configuration (YAML, advanced)

The default allow-list is `lark-cli` and `gh`. For fields the UI does not cover (`audit`, `upgradeFromReadOnly`, `extraPath`, `trace`) or for exact rule ordering, override the row in your profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`). Note that an override replaces the whole `config` — restate every field you need:

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

Manual YAML edits need a restart. Saves from the UI apply immediately.

> The first UI save writes a profile override containing the complete current config. Later changes to the bundle's default rules no longer override that row; to return to the defaults, delete the `config` section of `bash-sandbox-auto-approval` from the profile patch.

## Verify

Run each line **on its own** (a compound command is never granted):

```bash
lark-cli task +get-my-tasks      # succeeds, no approval prompt
gh api user --jq .login          # prints your login
touch ~/whitelist-probe          # still denied: file access denied under workspace-write
```

The last line is the control: the plugin widens the allow-list, not the session.

UI check: add or remove a rule in **Settings → Command Auto-Approval** (or the Plugins row page), save, and run the commands above immediately — no restart; the next bash call uses the new rules.

## Security

1. **The sandbox never restricted reads or the network.** Under `workspace-write` any command can already read `~/.ssh` or the tokens in `~/.lark-cli`. This plugin adds write capability, not read isolation.
2. **`home` means the whole home directory is writable**, including `~/.zshrc`, `~/Library/LaunchAgents/` and `~/.ssh/authorized_keys` — a persistence risk against a prompt-injected model.
3. **The allow-list trusts the entire program**, including its own download/export subcommands. Use `deny` to exclude the dangerous ones.
4. **`full` automates the full-access approval.** Use it deliberately.
5. **Aliases and wrappers are not matched** (`alias`, `env`, `timeout`, `npx …`), by design.
6. It only answers *"may this command's sandbox be widened"*, never *"should this command run"*.
7. **The UI adds no authority surface.** It writes the same profile `cordis.patch.yml` you could edit by hand; there is no new HTTP route and no agent tool. `full` rules require an explicit user acknowledgement.

## Limitations

- **One writable root.** `home` replaces `workspaceRoot`, so a matched command loses write access to the session workspace. Only matters when the workspace lives outside `$HOME`.
- **bash only.** Windows uses `pwsh-sandbox`; the row is disabled there.
- **Depends on `ctx.shell.resolve()`.** A future DSH release that changes the executor contract degrades the plugin to "no grants" — it does not break execution.
- **The UI manages `rules` only.** `audit`, `upgradeFromReadOnly`, `extraPath` and `trace` stay in YAML; the UI blocks duplicate commands (YAML can still order them by hand).

## Development

```bash
node --test "test/*.test.mjs"
```

## License

[MIT](./LICENSE)
