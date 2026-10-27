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
| **Add a writable root per command (this plugin)** | inside the kernel sandbox, workspace kept and `$HOME` added | this plugin |
| Add writable roots at config level | inside the kernel sandbox, for every command | dsh-write-protect, @morlay/dsh-sandbox-local |
| Command allow-list where `allow` grants escalation | outside the sandbox | dsh-sandbox-allowlist |
| Answer the approval for you | outside the sandbox, `allowed-once` | dsh-dhe-allow, dsh-auto-approval-plugin |

The difference is not how many prompts you skip, but **how much isolation you give up**: the last three either run the command outside the sandbox or add extra writable directories at config level for every command; this plugin's wider root applies only to the matched command, and it matches executables rather than command strings.

That is all it does. If you need deny rules, network policy or per-directory grants, the matching option above is the better fit.

## The problem

DSH's `workspace-write` sandbox only allows writes to the session workspace, `/tmp`, and the platform temp directory.

`lark-cli` refreshes its token under `~/Library/Application Support/lark-cli/` and keeps caches, locks and logs under `~/.lark-cli/`. Both are outside the workspace, so the command is denied, the model retries with `sandbox_permissions: danger-full-access`, and you get an approval prompt every time — or you give up file isolation for the entire session.

On macOS/Linux this plugin replaces that first denial with a wider *write scope for that one call*: the session workspace stays writable and the rule's directories are appended (`$HOME` by default; narrow them with `roots`). On Windows (or when the runner cannot be recognized) it falls back to the old behavior: `$HOME` replaces the writable root.

## How it works

Every bash call asks `ctx.shell.resolve(request)` for its `sandboxPolicy`. The plugin decorates that method inside `ctx.inject(['shell'])`:

```
tool-bash ──resolve(request)──▶ original resolve()   // workdir / timeout / policy
                                ├─ match the command
                                ├─ hit    → keep workspaceRoot, add extraWritableRoots = ['$HOME']
                                └─ no hit → returned unchanged
                              └─ ctx.sandbox.confine() ──▶ shipped provider builds argv
                                                           └─ overlay appends the extra root
```

The overlay appends per runner instead of rebuilding the profile:

- **Seatbelt (macOS):** append `(allow file-write* (subpath "$HOME"))` to the `-p` profile; SBPL's last match wins.
- **bwrap (Linux):** insert `--bind $HOME $HOME` before `--`.
- **Landlock (Linux):** insert `--rw $HOME` before `--`.
- An unknown runner, a missing `-p`/`--`, a missing path or an already-granted root leaves the shipped argv untouched and logs one warning.

Design choices:

- **It replaces no official row.** It decorates `ctx.shell.resolve()` and `ctx.sandbox.confine()`. The worst case is "the extra root was not added" — bash and the sandbox keep working.
- **Only the write scope changes.** Approval policy, filesystem tools and the session mode are untouched.
- **Fail safe.** Unknown syntax, invalid config, a bad regex or an unrecognized runner falls back to the normal sandbox and approval path. Mistakes cost extra prompts, never extra permission.
- **Windows does not use the overlay.** It falls back to replacing `workspaceRoot`; the ACL sandbox has no argv/profile to append to.

## Matching

The model hands over a whole shell string, not an argv, so the plugin answers one question: **is this
command's write footprint contained in the footprint of a trusted program?** The rule is a single
invariant:

> At grant time, everything the command may write is a subset of what the matched program may write.

That invariant does not care how the command is spelled, only whether it can still write somewhere
else. So one simple pipeline is accepted:

- The first stage must be an allow-listed program: `argv[0]` is resolved through `PATH` and
  `realpath`, and a binary inside the session workspace, `/tmp`, or the temp directory is refused
  (that is the one way a model could shadow the name from the repository).
- Later stages must be **write-neutral filters**: `tail`, `head`, and `wc`, with numeric or fixed
  flags only (`-12`, `-n 12`, `--lines=12`, `wc -l`). No path operands, no `-f`, and none of
  `tee` / `sh` / `sed -i` / `awk` / `sort -o` — those write files or start another program. Filters
  go through the same `PATH` + `realpath` + workspace/tmp checks.
- Redirects must open **no path at all**: `2>&1`, `1>&2`, `>&-`, `>/dev/null` (and `>>`).
- Quoted characters are not executed and are kept verbatim (`--text "a; b"` still works). `;`, `&`,
  `&&`, `$(...)`, backticks, `!`, newlines, heredocs, unterminated quotes, and commands over 8 KB are
  refused.
- `argv[0]` must be a bare command name, or an absolute path written in the config — `./lark-cli`
  and `/tmp/x/lark-cli` are not matched.
- **One exception: a single leading `cd <dir> &&`** (`allowCdPrefix`, on by default). Models
  habitually write `cd /repo && lark-cli ...` even though the `bash` tool has a `workdir` parameter.
  `cd` is a builtin that only moves the working directory, so it is the same request as `workdir`:
  the prefix is stripped and its target becomes the effective working directory. Only the *first*
  `&&` is split off; the remainder is parsed by the pipeline rules above. Set `allowCdPrefix: false`
  to disable the exception.

### Shapes that match

| Shape | Result |
|---|---|
| `lark-cli docs +update ...` (with `workdir`) | matched |
| `cd /repo && lark-cli docs +update ...` | matched |
| the same, plus a trailing `2>&1` | matched |
| the same, piped into `\| tail -12` | matched |
| the same, piped into `\| head -n 20` or `\| wc -l` | matched |
| the same, with `> out.log` or `>\| out.log` | refused (writes a file) |
| the same, with `\| tee out.log`, `\| sh`, or `\| tail -f` | refused (writes / starts another program) |
| the same, with `; echo done` or `&& echo done` | refused (second command) |
| the same, with `\| tail $(echo 3)` | refused (command substitution) |

`2>&1 | tail -12` is the shape models reach for most, and it now matches. The one cost: the exit code the model sees becomes
`tail`'s, so a failing `lark-cli` can hide behind a successful `tail`. Piping output is therefore
still not recommended for commands whose exit status matters — it just no longer costs a prompt.

### No `AGENTS.md` in every repository

The plugin tells the model itself: it registers one system-prompt section
(`tool:bash:auto-approval`, right after `tool:bash`) generated from the live rules — which commands
are granted, which shapes are recognized, and which ones fall back to approval.

- It follows the installation, so every repository does not need to repeat the note;
- a rule saved in Settings updates the text on the next model step, with no restart;
- `promptHint: false` removes the section. It is guidance only: the matcher still decides, and a
  model that ignores it merely gets the normal approval prompt.

An `AGENTS.md` note is still allowed, but it is a project preference now, not a requirement of this
plugin.

### Narrow roots and "any shape" (`roots` / `shape`)

The shape check and the width of the roots compensate for each other: the wider the root, the stricter
the grammar has to be. They are two separate steps.

**First, narrow the roots (no grammar is relaxed):**

```yaml
- name: lark-cli
  command: lark-cli
  roots:                                  # only these two directories outside the workspace
    - ~/.lark-cli
    - ~/Library/Application Support/lark-cli
  shape: strict                           # the default: the shape table above still applies
```

`~/.zshrc`, `~/Library/LaunchAgents/` and `~/.ssh` are no longer inside the writable set. This is the
highest-value tightening available, and it changes no matching behavior.

**Second, turn on `shape: any` when complex commands are the norm:**

```yaml
- name: lark-cli
  command: lark-cli
  roots: [~/.lark-cli, ~/Library/Application Support/lark-cli]
  shape: any
```

The matcher stops reading the grammar and only requires the program name to appear as a word
(quoted text counts as one word; comments and redirect targets do not). `| tee`, `;`, `&&`, `for`
loops and `xargs` then match, while writes stay limited to the listed roots by the kernel.

Still refused:

- a path the model chose (`./lark-cli`, `/tmp/x/lark-cli`) — the shadowing vector;
- `bash -c 'lark-cli …'`, where the name is inside a quoted word (one more prompt, never a wrong grant);
- `shape: any` with `$HOME` (or an ancestor of it): the rule is dropped at load time with a warning —
  "any shape" leaves only the roots as a boundary, and handing it the whole home directory means
  "any command may write home".

Four costs to accept before using `any`:

1. **The list must be complete.** A missing directory makes the command fail **while running**
   with `[sandbox: file access denied …]`, which sends the model into the escalation dance this
   plugin exists to remove — how often depends on how complete the list is.
2. **Name matching is no longer a realpath check.** `shape: any` reads strings, so the PATH-shadow
   check does not apply and the kernel's roots are the only boundary.
3. **App-private directories are still persistence.** If the CLI loads configuration or hooks from
   that directory, writing there means code execution next run. Judge per app: narrow is not the
   same as harmless.
4. **A missing overlay leaves the extra roots inert.** On POSIX a grant is always "workspace + the
   listed roots"; when the root overlay is not installed only the workspace is writable, the Host log
   warns once, and the audit line is marked `(root overlay inactive)`. It never degrades into "only
   the first root".
5. **Windows** cannot express several roots: a multi-root rule uses the first one and warns.

Suggested order: run `roots` + `strict` first, confirm no new `file access denied`, then switch only
the rules that genuinely need complex commands to `any`.

## Install

Requirements: DSH Desktop (profile-based), macOS or Linux, bash path.

### From npm

The package is published on npm:

```text
plugin_manager(action="install_bundle", target="dsh-whitelist-auto-approval")
```

Or use **Add plugin** on the Plugins page with `dsh-whitelist-auto-approval` (optionally `dsh-whitelist-auto-approval@0.4.0-beta`).

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

The default allow-list is `lark-cli` and `gh`. For fields the UI does not cover (`audit`, `upgradeFromReadOnly`, `extraPath`, `allowCdPrefix`, `promptHint`, `trace`) or for exact rule ordering, override the row in your profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`). Note that an override replaces the whole `config` — restate every field you need:

```yaml
- id: bash-sandbox-auto-approval
  config:
    audit: true
    upgradeFromReadOnly: false
    extraPath: []
    allowCdPrefix: true
    promptHint: true
    rules:
      - { name: lark-cli, command: lark-cli, grant: home }
      - { name: gh, command: gh, grant: home, deny: ['\bapi\b.*--method\s+DELETE'] }
      - { name: my-tool, command: /opt/homebrew/bin/my-tool, grant: custom, root: ~/.my-tool }
      - name: lark-cli-narrow
        command: lark-cli
        roots:                          # multi-root: only these two directories outside the workspace
          - ~/.lark-cli
          - ~/Library/Application Support/lark-cli
        shape: any                      # stop reading the grammar; only with narrow roots
```

| Field | Required | Meaning |
|---|---|---|
| `command` | yes | bare command name, or an absolute path |
| `name` | no | label used in logs (defaults to `command`) |
| `grant` | no | `home` (default) / `custom` / `roots` / `full` |
| `root` | for `custom` | writable root, absolute or `~/...` |
| `roots` | no | list of writable roots (absolute or `~/...`); takes precedence over `grant` / `root` |
| `shape` | no | `strict` (default) or `any`: whether the command grammar is parsed |
| `deny` | no | regexes over the raw command line; any match cancels the grant |
| `allow` | no | regexes; when non-empty at least one must match |

`deny` / `allow` always run against the **raw command string**, `cd` prefix included, so an
`allow` anchored at the start (`^lark-cli`) will not match `cd /x && lark-cli ...`. That fails
on the safe side: a missing match means one more prompt, never one more grant.

Top-level switches (not per-rule):

| Field | Default | Meaning |
|---|---|---|
| `allowCdPrefix` | `true` | Accept one leading `cd <dir> &&`: strip it, resolve against that directory, keep matching. `false` drops the `cd` prefix (write-neutral pipelines still match) |
| `audit` | `true` | Write one Host log line per grant |
| `upgradeFromReadOnly` | `false` | Do not widen a `read-only` session |
| `extraPath` | `[]` | Extra PATH entries (a GUI-launched process can have a short PATH) |
| `trace` | unset | Optional JSONL of every decision (non-match reason, matched rule, writable root) |

`grant` / `roots` (on macOS/Linux with the overlay every root is **appended**, so the session
workspace stays writable):

| Value | Actual policy | Use for |
|---|---|---|
| `home` | workspace + `$HOME` | CLIs that write their own state in your home and also write into the workspace |
| `custom` | workspace + `root` | tighten to a single directory |
| `roots: [...]` | workspace + every listed directory | the form worth preferring: narrow `$HOME` to app-private directories |
| `full` | `danger-full-access` | genuinely unconstrained work (automates the full-access approval) |

On POSIX a grant is always **"workspace + the listed roots"** and never a replacement: when the root
overlay is not installed the extra roots are merely inert (the command keeps the workspace), the Host
log warns once, and the audit line says `(root overlay inactive)`. The failure mode is therefore "the
sandbox denied one write", not "the writable root was silently swapped for another directory".
Windows can only carry one root: `home` becomes `$HOME`, and a multi-root rule uses its first root
and warns once.

Manual YAML edits need a restart. Saves from the UI apply immediately.

> The first UI save writes a profile override containing the complete current config. Later changes to the bundle's default rules no longer override that row; to return to the defaults, delete the `config` section of `bash-sandbox-auto-approval` from the profile patch.

## Verify

Run each line **on its own**. `;`, `&&`, `> file` and `| tee` are never granted; a single leading
`cd <dir> &&`, `2>&1`, `>/dev/null`, `| tail -N`, `| head -N` and `| wc` are recognised:

```bash
lark-cli task +get-my-tasks                          # succeeds, no approval prompt
lark-cli task +get-my-tasks 2>&1 | tail -5           # also succeeds: a write-neutral pipe
gh api user --jq .login                              # prints your login
touch ~/whitelist-probe                              # still denied: file access denied under workspace-write
cd ~ && lark-cli task +get-my-tasks                  # also succeeds: the single cd prefix is the same command
lark-cli task +get-my-tasks | tee /tmp/out           # denied and prompted: tee writes a file
```

The last two lines are the control: the plugin widens the allow-list and write-neutral pipes, not
the session.

On macOS/Linux the matched command keeps the session workspace too: refreshing a token and
writing a download/export back into `./` in the same command is no longer denied (`home` is
now "workspace + `$HOME`").

UI check: add or remove a rule in **Settings → Command Auto-Approval** (or the Plugins row page), save, and run the commands above immediately — no restart; the next bash call uses the new rules.

## Security

1. **The sandbox never restricted reads or the network.** Under `workspace-write` any command can already read `~/.ssh` or the tokens in `~/.lark-cli`. This plugin adds write capability, not read isolation.
2. **`home` means the whole home directory is writable**, including `~/.zshrc`, `~/Library/LaunchAgents/` and `~/.ssh/authorized_keys` — a persistence risk against a prompt-injected model.
3. **The allow-list trusts the entire program**, including its own download/export subcommands. Use `deny` to exclude the dangerous ones.
4. **`full` automates the full-access approval.** Use it deliberately.
5. **Aliases and wrappers are not matched** (`alias`, `env`, `timeout`, `npx …`), by design.
6. It only answers *"may this command's sandbox be widened"*, never *"should this command run"*.
7. **Pipeline stages are trusted at the same level as the matched program.** `tail` / `head` / `wc` are resolved through `PATH` + `realpath` too; they simply accept no path operand and no flag that writes a file or starts another program. An attacker who can hijack `PATH` could already hijack the matched program.
8. **`shape: any` leaves the kernel as the only boundary.** Matching is string-level (`echo lark-cli` counts) and the PATH-shadow check no longer applies; safety depends entirely on how narrow the roots are.
9. **The UI adds no authority surface.** It writes the same profile `cordis.patch.yml` you could edit by hand; there is no new HTTP route and no agent tool. `full` rules require an explicit user acknowledgement.

## Limitations

- **Two writable roots on macOS/Linux, one on Windows.** On macOS/Linux a `home` grant keeps the session workspace and appends `$HOME`; on Windows (or an unrecognized runner) it still replaces `workspaceRoot`, so a matched command loses write access to the session workspace.
- **The overlay is best effort.** It only appends to the shipped runner profile; an unknown runner, a changed argv shape or a missing path leaves the shipped confinement untouched and logs one warning. The result is a missing extra root, not a wider sandbox.
- **`write`/`edit` are not covered.** The overlay only widens the sandboxed command; writing `$HOME` through the file tools still follows the session policy.
- **Do not mix it with a plugin that owns the `sandbox` provider.** The overlay appends its allow to the final argv/profile; a plugin that appends its own deny in the same profile can end up on the wrong side of the order. This plugin assumes the official `dsh-sandbox-local` provider.
- **bash only.** Windows uses `pwsh-sandbox`; the overlay is not installed there and `home` falls back to replacing the root. The `cd` prefix is POSIX `&&` only, so pwsh's `cd x; cmd` still does not match.
- **One `cd` prefix only.** `cd a && cd b && …`, `pushd` and `(cd a && …)` do not match; use the bash tool's `workdir` for nested directory changes.
- **Only write-neutral pipes match.** `| tail`, `| head` and `| wc` with numeric arguments match; `| tee`, `| sh`, `| sed -i`, `| awk`, `| tail -f` and `> file` go back to the normal approval prompt.
- **A pipe changes the exit code the model sees.** `a | tail -12` reports `tail`'s status, so a failing `a` can hide; drop the pipe when the exit status matters.
- **The prompt section is best effort.** `promptHint` lowers the chance of a wrong shape; the matcher still decides, and a model that ignores the hint merely gets one more prompt.
- **`shape: any` matching is string-level.** `echo lark-cli` counts (and receives the narrow roots), while `bash -c 'lark-cli …'` does not; comments and redirect targets are ignored.
- **`shape: any` cannot use `$HOME`.** Such a rule is dropped at load time with a warning (see "Narrow roots and any shape").
- **Multi-root does not exist on Windows.** Only the first root is used, with one warning.
- **A missing `roots` entry fails at run time.** `custom` / `roots` are no longer "wide enough" like `home`: a forgotten directory triggers a sandbox denial and possibly the escalation prompt.
- **Depends on `ctx.shell.resolve()`.** A future DSH release that changes the executor contract degrades the plugin to "no grants" — it does not break execution.
- **The UI manages `rules` only.** `audit`, `upgradeFromReadOnly`, `extraPath` and `trace` stay in YAML; the UI blocks duplicate commands (YAML can still order them by hand).

## Development

```bash
node --test "test/*.test.mjs"
```

## License

[MIT](./LICENSE)
