# dsh-whitelist-auto-approval

简体中文 | [English](./README.en.md)

给 DSH 的 bash 沙箱加一份**按命令生效的白名单**：让 `lark-cli`、`gh` 这类必须写用户目录的命令不再触发 `danger-full-access` 授权弹窗，同时**不**把整个会话切换成完全权限。

```
命令只写工作区            → 不需要本插件（默认就能写）
命令要写 ~/.xxx、~/Library → 加入白名单，仍然受内核沙箱约束
非白名单命令               → 行为完全不变，该弹窗照旧弹
```

## 和同类插件的区别

DSH 上已有一批解决"工作区外写入"的插件。按**放行后命令在哪执行**，大致分四类：

| 做法 | 放行后命令在哪执行 | 代表 |
|---|---|---|
| **按命令追加可写根（本插件）** | 内核沙箱内，工作区保留，`$HOME` 作为第二根追加 | 本插件 |
| 扩展沙箱可写目录（配置级） | 内核沙箱内，配置的目录对所有命令生效 | dsh-write-protect、@morlay/dsh-sandbox-local |
| 命令白名单，allow 含升级授权 | 沙箱外 | dsh-sandbox-allowlist |
| 审批代答 | 沙箱外，返回 `allowed-once` | dsh-dhe-allow、dsh-auto-approval-plugin |

差距不只在"少点几次弹窗"，而在**放行时失去多少隔离**：后三类要么让命令直接到沙箱外跑，要么把额外可写目录做成对所有命令生效的全局配置；本插件的可写根只对命中的那条命令生效，且匹配的是可执行文件而不是命令字符串。

它只解决这一件事。需要 deny 规则、网络策略或按目录授权时，用上表里对应的方案更合适。

## 它解决什么问题

DSH 的 `workspace-write` 沙箱只允许写三类位置：会话工作区、`/tmp`、系统临时目录（`os.tmpdir()`）。

而 `lark-cli` 刷新 token 时要写 `~/Library/Application Support/lark-cli/`，平时还要写 `~/.lark-cli/`（cache / locks / logs）。这些都在工作区之外，于是：

1. 命令被内核拒绝；
2. 模型按工具描述带 `sandbox_permissions: danger-full-access` 重试；
3. 你每次都要点一次授权；
4. 如果干脆把会话切成"完全权限"，那整个会话都失去文件隔离。

本插件在 macOS / Linux 上把第 1 步变成"这次调用的可写根 = 会话工作区 + `$HOME`"：
token 能写，命令自己的下载/导出也能写回工作区，于是第 2、3 步不再发生。
Windows（或无法识别 runner 的 provider）退回旧行为：把可写根换成 `$HOME`。

## 工作原理

DSH 里每条 bash 命令都会经过 `ctx.shell.resolve(request)` 拿到 `sandboxPolicy`，再由 `ctx.sandbox.confine()` 翻译成 runner 的 argv/profile。插件在这两个位置各装饰一层（macOS / Linux）：

```
tool-bash ──resolve(request)──▶ 原 resolve()            // workdir/timeout/policy 原逻辑
                                ├─ 匹配命令（见下）
                                ├─ 命中 → 保留 workspaceRoot，追加 extraWritableRoots = ['$HOME']
                                └─ 未命中/异常 → 原样返回
                              └─ ctx.sandbox.confine() ──▶ 原 provider 生成 argv
                                                           └─ overlay：在 profile/参数末尾追加可写根
```

overlay 按 runner 追加，不重建 profile：

- **Seatbelt**（macOS）：在 `-p` 的 profile 末尾追加 `(allow file-write* (subpath "$HOME"))`；SBPL 后匹配生效。
- **bwrap**（Linux）：在 `--` 前插 `--bind $HOME $HOME`。
- **Landlock**（Linux）：在 `--` 前插 `--rw $HOME`。
- 识别不出 runner、缺 `-p`/`--`、路径不存在、或该根已经在 profile 里时，原样返回并告警一次。

几点设计上的取舍：

- **不替换任何官方 row**，只装饰 `ctx.shell.resolve()` 和 `ctx.sandbox.confine()`。overlay 失败时最坏是"这次没加上根"，bash 和沙箱本身照常工作。
- **只放宽"写哪里"**，不改审批策略、不改文件系统工具、不改会话模式。
- **失败安全**：任何解析不确定、配置非法、正则写错、runner 不认识，都退回原沙箱 + 原审批——宁可多弹窗，不会少弹窗。
- **Windows 不适用 overlay**：退回旧行为（`workspaceRoot` 换成 `$HOME`），因为 ACL 沙箱没有可追加的 argv/profile。

## 匹配规则

模型给的是一整条 shell 字符串，不是 argv。所以插件做一次保守词法分析，只放行"一条简单命令"：

- 接受：普通参数、单/双引号、反斜杠转义；
- 拒绝：`;` `&` `|` `<` `>` `(` `)` `{` `}` `` ` `` `$` `!`、换行、双引号内的 `$` 与反引号、未闭合引号；
- `argv[0]` 必须是裸命令名，或配置里写死的绝对路径；`./lark-cli`、`/tmp/x/lark-cli` 这类"模型自己指定的路径形式"不匹配；
- 用 `PATH` 解析出真实文件（`realpath`），并拒绝落在**会话工作区 / `/tmp` / 系统临时目录**里的可执行文件——这是模型唯一能靠"往仓库里丢个同名脚本"劫持命名的路径。

## 安装

要求：DSH Desktop（带 profile），macOS 或 Linux，bash 路径。

### 从 npm 安装

包已发布到 npm，推荐直接安装：

```text
plugin_manager(action="install_bundle", target="dsh-whitelist-auto-approval")
```

或在 Plugins 页 **Add plugin** 里填包名 `dsh-whitelist-auto-approval`（可带版本，如 `dsh-whitelist-auto-approval@0.3.0`）。

要跟仓库最新提交、或从本地目录调试时，用下面的 GitHub / 本地目录方式。

### 从 GitHub 安装

```text
plugin_manager(action="install_bundle", target="https://github.com/laoer/dsh-whitelist-auto-approval.git")
```

### 从本地目录安装

```text
plugin_manager(action="install_bundle", target="/绝对路径/dsh-whitelist-auto-approval")
```

### Desktop 与 CLI

- **Desktop**：Plugins → **Add plugin** 支持 npm 包名、Git 地址、tarball、本地绝对路径。
- **CLI**：`dsh plugin add dsh-whitelist-auto-approval`（或 Git 地址）适用于 CLI 管理的 profile。Desktop 的 profile 由应用持有，不暴露给 CLI profile 查找；Desktop 用户请使用 Plugins 页或上面的 `plugin_manager`。

装完如果 `Plugins` 页里没看到这个 bundle，完全退出 DSH 再打开一次。首次安装或更新本插件后需要重启一次，让 Web 端加载 `client.js`；之后在 UI 里改规则不需要重启。

## 在 UI 中管理白名单（推荐）

重启后：

1. 打开左下角 **设置**；
2. 在左侧列表点 **命令自动放行**；
3. 在右侧规则表增删改规则，点 **保存**。

同一个表单也能从 Plugins 页进入：侧边栏 **Plugins** → **Command Auto-Approval** → 点 `bash-sandbox-auto-approval` 这一行的标题（右侧有 `›` 箭头）。

保存会写入 profile 的 `cordis.patch.yml`，并**对下一次 bash 调用立即生效**，无需重启。UI 管理规则表（`command` / `name` / `grant` / `root` / `deny` / `allow`）；`audit`、`extraPath`、`trace` 等高级项仍在 profile patch 里。选 `grant: full` 时会显示警告并要求显式勾选确认。

白名单修改始终是用户操作：本插件不注册任何可改白名单的 agent 工具。

## 配置（YAML，高级用法）

默认白名单是 `lark-cli` 和 `gh`。UI 覆盖不到的字段（`audit`、`upgradeFromReadOnly`、`extraPath`、`trace`）或需要精调顺序时，仍可直接编辑 profile 的 patch 文件（`~/.dsh/profiles/<profile>/cordis.patch.yml`），覆盖本插件的 row——**同 id 的 `config` 是整段替换，不是合并**，所以要把需要的字段写全：

```yaml
- id: bash-sandbox-auto-approval
  config:
    audit: true                 # 每次放行写一行 Host 日志
    upgradeFromReadOnly: false  # 会话在 read-only 时不越权
    extraPath: []               # PATH 里找不到命令时，额外搜索的目录
    rules:
      - name: lark-cli
        command: lark-cli       # 裸命令名（经 PATH 解析）
        grant: home             # 可写 $HOME，仍受沙箱约束
      - name: gh
        command: gh
        grant: home
        deny: ['\bapi\b.*--method\s+DELETE']   # 命中就不放行
      - name: my-tool
        command: /opt/homebrew/bin/my-tool     # 绝对路径形式
        grant: custom
        root: ~/.my-tool        # 只允许写这个目录
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 裸命令名或绝对路径 |
| `name` | 否 | 日志里的标签，默认取 `command` |
| `grant` | 否 | `home`（默认）/ `custom` / `full` |
| `root` | `custom` 时必填 | 绝对路径或 `~/...` |
| `deny` | 否 | 正则数组，作用于原始命令串；任一命中即不放行 |
| `allow` | 否 | 正则数组；非空时必须命中其一才放行 |

`grant` 三种取值的区别：

| 值 | 实际策略 | 适用 |
|---|---|---|
| `home` | macOS/Linux：`workspace-write`，工作区保留 + `$HOME` 追加为第二根；Windows 或无 overlay：可写根换成 `$HOME` | 写自己家目录、同时还要往工作区落盘的 CLI（推荐） |
| `custom` | `workspace-write`，可写根换成 `root` | 只需要单个目录时收紧 |
| `full` | `danger-full-access` | 确实需要无约束（等于把"批准完全权限"自动化） |

手改 YAML 后需要重启 DSH 生效；通过 UI 保存则即时生效。

> 第一次在 UI 里保存会生成一份 profile override（包含当前完整 config）。之后 bundle 自带的默认规则变化不会再自动覆盖这份 override；需要回到默认时，删除 profile patch 里 `bash-sandbox-auto-approval` 的 `config` 段即可。

## 验证

在 `workspace-write` 会话里逐条执行（**不要**用 `;` `&&` 拼起来，组合命令不会命中规则）：

```bash
lark-cli task +get-my-tasks      # 期望成功，且没有授权弹窗
gh api user --jq .login          # 期望返回你的用户名
touch ~/whitelist-probe          # 期望仍被拒：file access denied under workspace-write
```

最后一条是对照组：插件只放行白名单，没有把会话变成完全权限。

macOS/Linux 上，命中命令的沙箱同时保留工作区：同一轮里刷新 token 再把下载/导出写回
`./` 不会被拒绝（`home` 现在是"工作区 + `$HOME`"两个根）。

UI 验证：在 **设置 → 命令自动放行**（或 Plugins 行页）添加或删除一条规则并保存，然后**立刻**执行上面的命令（不需要重启）；保存后的下一次 bash 调用就会使用新规则。

## 安全边界（请务必读）

1. **沙箱本来就不限制读和网络。** `workspace-write` 下任何命令都能读 `~/.ssh`、`~/.lark-cli` 里的 token。本插件增加的是**写**的能力，不是读的隔离。
2. **`home` 授权 = 可写整个家目录**，包括 `~/.zshrc`、`~/Library/LaunchAgents/`、`~/.ssh/authorized_keys`。对一个被提示注入的模型，这是持久化风险。
3. **白名单信任的是整个程序**，包括它自己的下载/导出子命令（例如 `lark-cli drive +download --output <路径>`）。需要更严就用 `deny` 把高危子命令排除。
4. **`full` 等于自动批准完全权限**，只在明确需要时用。
5. **别名/包装器不放行**：`alias`、shell 函数、`env`、`timeout`、`npx` 包一层的写法都不会命中，会正常弹窗。这是刻意的。
6. 它只回答"这条命令的沙箱边界能不能放宽"，**不回答"这条命令该不该跑"**。
7. **UI 不新增权限面**：保存写入的就是 profile 的 `cordis.patch.yml`，与手工编辑同一份文件；没有新增 HTTP 路由或 agent 工具。`full` 规则需要用户显式确认。

## 已知限制

- **macOS/Linux 两个可写根，Windows 一个**：macOS/Linux 上 `home` 会保留会话工作区并追加 `$HOME`；Windows（或 provider runner 无法识别）仍然会覆盖 `workspaceRoot`，命中命令会失去对工作区的写权限。
- **overlay 是尽力而为**：它只是在官方 runner 的 profile/argv 上追加；runner 不认识、argv 形状变了、路径不存在，都会原样返回并告警一次。结果是"这次没加上根"，不是"放宽了沙箱"。
- **`write`/`edit` 不覆盖**：overlay 只放宽被沙箱约束的命令；用文件工具写 `$HOME` 仍按会话策略走。
- **不要和接管 `sandbox` provider 的插件混用**：overlay 的 allow 追加在最终 argv/profile 末尾；如果别的插件在同一 profile 里追加了自己的 deny，顺序可能反过来。本插件假设 provider 是官方 `dsh-sandbox-local`。
- **只处理 bash**：Windows 上 DSH 走 `pwsh-sandbox`；overlay 在 win32 不安装，`home` 退回替换根。
- **依赖 `ctx.shell.resolve()` 这个方法名**：DSH 升级若改变执行器契约，插件会退化为"不放行"，不会破坏执行。
- **UI 只管理 `rules`**：`audit`、`upgradeFromReadOnly`、`extraPath`、`trace` 仍在 YAML；同一 `command` 的重复规则在 UI 中被阻止（YAML 仍可按顺序手写）。
- **不能替代人工判断**。

## 目录

```
dsh-whitelist-auto-approval/
├── package.json          # bundle + dsh.client 清单
├── cordis.patch.yml      # 插入 bash-sandbox-auto-approval 这一行
├── index.js              # 装饰 ctx.shell.resolve()，读取 volatile rules
├── overlay.js            # 装饰 ctx.sandbox.confine()，按 runner 追加额外可写根
├── schema.js             # Config schema（rules 为 volatile）
├── client.js             # Web UI：Settings 页 + plugins.row.config 规则表
├── matcher.js            # 词法分析 / PATH 解析 / 规则匹配
├── vendor/               # vendored schemastery + cosmokit（MIT）
├── locale/{en,zh}.json
├── icon.svg
└── test/                 # node --test，无需安装 DSH
```

跑测试：

```bash
node --test "test/*.test.mjs"
```

## License

[MIT](./LICENSE)
