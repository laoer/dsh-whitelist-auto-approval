# dsh-whitelist-auto-approval

简体中文 | [English](./README.en.md)

给 DSH 的 bash 沙箱加一份**按命令生效的白名单**：让 `lark-cli`、`gh` 这类必须写用户目录的命令不再触发 `danger-full-access` 授权弹窗，同时**不**把整个会话切换成完全权限。

```
命令只写工作区            → 不需要本插件（默认就能写）
命令要写 ~/.xxx、~/Library → 加入白名单，仍然受内核沙箱约束
非白名单命令               → 行为完全不变，该弹窗照旧弹
```

## 它解决什么问题

DSH 的 `workspace-write` 沙箱只允许写三类位置：会话工作区、`/tmp`、系统临时目录（`os.tmpdir()`）。

而 `lark-cli` 刷新 token 时要写 `~/Library/Application Support/lark-cli/`，平时还要写 `~/.lark-cli/`（cache / locks / logs）。这些都在工作区之外，于是：

1. 命令被内核拒绝；
2. 模型按工具描述带 `sandbox_permissions: danger-full-access` 重试；
3. 你每次都要点一次授权；
4. 如果干脆把会话切成"完全权限"，那整个会话都失去文件隔离。

本插件把第 1 步变成"这次调用的沙箱边界换成 `$HOME`"，于是第 2、3 步不再发生。

## 工作原理

DSH 里每条 bash 命令都会经过 `ctx.shell.resolve(request)` 拿到本次调用的 `sandboxPolicy`。插件在 `ctx.inject(['shell'])` 里给这个方法套一层：

```
tool-bash ──resolve(request)──▶ 原 resolve()            // workdir/timeout/policy 原逻辑
                                ├─ 匹配命令（见下）
                                ├─ 命中 → sandboxPolicy = { mode: 'workspace-write', workspaceRoot: '$HOME' }
                                └─ 未命中/异常 → 原样返回
                              └─ execute() 由原执行器完成，沙箱照常生效
```

几点设计上的取舍：

- **不替换 `ctx.shell`**，只装饰方法。插件出问题时最坏结果是"规则不生效"，bash 本身照常工作。
- **只放宽"写哪里"**，不改审批策略、不改文件系统工具、不改会话模式。
- **失败安全**：任何解析不确定、配置非法、正则写错，都退回原沙箱 + 原审批——宁可多弹窗，不会少弹窗。

## 匹配规则

模型给的是一整条 shell 字符串，不是 argv。所以插件做一次保守词法分析，只放行"一条简单命令"：

- 接受：普通参数、单/双引号、反斜杠转义；
- 拒绝：`;` `&` `|` `<` `>` `(` `)` `{` `}` `` ` `` `$` `!`、换行、双引号内的 `$` 与反引号、未闭合引号；
- `argv[0]` 必须是裸命令名，或配置里写死的绝对路径；`./lark-cli`、`/tmp/x/lark-cli` 这类"模型自己指定的路径形式"不匹配；
- 用 `PATH` 解析出真实文件（`realpath`），并拒绝落在**会话工作区 / `/tmp` / 系统临时目录**里的可执行文件——这是模型唯一能靠"往仓库里丢个同名脚本"劫持命名的路径。

## 安装

要求：DSH Desktop（带 profile），macOS 或 Linux，bash 路径。

在 DSH 会话里让 agent 执行：

```text
plugin_manager(action="install_bundle", target="https://github.com/laoer/dsh-whitelist-auto-approval.git")
```

或在 Plugins 页 **Add plugin** 里填同一个地址。也可以从本地目录安装：

```text
plugin_manager(action="install_bundle", target="/绝对路径/dsh-whitelist-auto-approval")
```

装完如果 `Plugins` 页里没看到这个 bundle，完全退出 DSH 再打开一次。

## 配置

默认白名单是 `lark-cli` 和 `gh`。增删规则：编辑 profile 的 patch 文件（`~/.dsh/profiles/<profile>/cordis.patch.yml`），覆盖本插件的 row——**同 id 的 `config` 是整段替换，不是合并**，所以要把需要的字段写全：

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
| `home` | `workspace-write`，可写根 = `$HOME` | 写自己家目录的 CLI（推荐） |
| `custom` | `workspace-write`，可写根 = `root` | 只需要单个目录时收紧 |
| `full` | `danger-full-access` | 确实需要无约束（等于把"批准完全权限"自动化） |

改完配置后重启 DSH 生效。

## 验证

在 `workspace-write` 会话里逐条执行（**不要**用 `;` `&&` 拼起来，组合命令不会命中规则）：

```bash
lark-cli task +get-my-tasks      # 期望成功，且没有授权弹窗
gh api user --jq .login          # 期望返回你的用户名
touch ~/whitelist-probe          # 期望仍被拒：file access denied under workspace-write
```

最后一条是对照组：插件只放行白名单，没有把会话变成完全权限。

## 安全边界（请务必读）

1. **沙箱本来就不限制读和网络。** `workspace-write` 下任何命令都能读 `~/.ssh`、`~/.lark-cli` 里的 token。本插件增加的是**写**的能力，不是读的隔离。
2. **`home` 授权 = 可写整个家目录**，包括 `~/.zshrc`、`~/Library/LaunchAgents/`、`~/.ssh/authorized_keys`。对一个被提示注入的模型，这是持久化风险。
3. **白名单信任的是整个程序**，包括它自己的下载/导出子命令（例如 `lark-cli drive +download --output <路径>`）。需要更严就用 `deny` 把高危子命令排除。
4. **`full` 等于自动批准完全权限**，只在明确需要时用。
5. **别名/包装器不放行**：`alias`、shell 函数、`env`、`timeout`、`npx` 包一层的写法都不会命中，会正常弹窗。这是刻意的。
6. 它只回答"这条命令的沙箱边界能不能放宽"，**不回答"这条命令该不该跑"**。

## 已知限制

- **只有一个可写根**：`home` 会覆盖 `workspaceRoot`，所以命中命令会失去对**会话工作区**的写权限。只在"工作区在 `$HOME` 之外"时才有影响；需要同时写两边的命令不适合加白名单。
- **只处理 bash**：Windows 走 `pwsh-sandbox`，本插件的 row 在 win32 下禁用。
- **依赖 `ctx.shell.resolve()` 这个方法名**：DSH 升级若改变执行器契约，插件会退化为"不放行"，不会破坏执行。
- **没有图形化配置**：插件不声明 Config schema，规则走 YAML。`Plugins` 页仍可开关这个 bundle。
- **不能替代人工判断**。

## 目录

```
dsh-whitelist-auto-approval/
├── package.json          # bundle 清单
├── cordis.patch.yml      # 插入 bash-sandbox-auto-approval 这一行
├── index.js              # 装饰 ctx.shell.resolve()
├── matcher.js            # 词法分析 / PATH 解析 / 规则匹配
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
