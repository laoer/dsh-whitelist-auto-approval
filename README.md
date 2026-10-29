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

本插件在 macOS / Linux 上把第 1 步变成"这次调用的可写根 = 会话工作区 + 该规则声明的目录"
（默认 `$HOME`，用 `roots` 可以收窄到 app 私有目录）：token 能写，命令自己的下载/导出也能
写回工作区，于是第 2、3 步不再发生。
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

模型给的是一整条 shell 字符串，不是 argv。插件只回答一个问题：**这条命令的写足迹，是否落在被信任程序的写足迹之内**。判据只有一条：

> 放行时，整条命令能写的位置 ⊆ 匹配到的那个程序自己能写的位置。

这条判据不关心命令怎么拼写，只关心它还能不能写到别处。所以插件接受"一条简单管道"：

- 第一段必须是放行的白名单程序：`argv[0]` 经 `PATH` 解析、`realpath` 校验；落在会话工作区 / `/tmp` / 系统临时目录里的可执行文件一律拒绝（这是模型唯一能靠"往仓库里丢个同名脚本"劫持命名的路径）。
- 后面的管道段只允许**写中立过滤器**：`tail`、`head`、`wc`，且参数只能是纯数字或固定开关（`-12`、`-n 12`、`--lines=12`、`wc -l`）。不认路径操作数，不认 `-f`，也不认 `tee` / `sh` / `sed -i` / `awk` / `sort -o` 这类会写文件或再起程序的工具。过滤器同样要过 `PATH` + `realpath` + workspace/tmp 检查。
- 重定向只允许**不打开任何路径**的形态：`2>&1`、`1>&2`、`>&-`、`>/dev/null`（`>>` 同）。
- 引号内的字符不参与执行，保留原样（`--text "a; b"` 仍然可用）；拒绝 `;`、`&`、`&&`、`$(...)`、反引号、`!`、换行、heredoc、未闭合引号、8KB 以上的命令。
- `argv[0]` 必须是裸命令名，或配置里写死的绝对路径；`./lark-cli`、`/tmp/x/lark-cli` 这类"模型自己指定的路径形式"不匹配。
- **例外：一个开头的 `cd <目录> &&`**（`allowCdPrefix`，默认开）。模型常按别的 agent 的习惯写成
  `cd /repo && lark-cli ...`，虽然 bash 工具有 `workdir` 参数。`cd` 只是内建命令、只改工作目录，
  和 `workdir` 是同一个请求，所以剥掉这段前缀、用 `cd` 目标作为工作目录继续匹配。
  只认**第一个** `&&`，剩下的部分仍按上面的管道规则解析。不想要这条例外就设 `allowCdPrefix: false`。

### 能被放行的写法

| 写法 | 结果 |
|---|---|
| `lark-cli docs +update ...`（配 `workdir`） | ✅ 命中 |
| `cd /repo && lark-cli docs +update ...` | ✅ 命中 |
| `cd /repo && lark-cli docs +update ... 2>&1` | ✅ 命中 |
| 同上，再接 `\| tail -12` | ✅ 命中 |
| 同上，改用 `\| head -n 20`、`\| wc -l` | ✅ 命中 |
| 同上，改成 `> out.log` 或 `>\| out.log` | ❌ 会写文件 |
| 同上，改成 `\| tee out.log`、`\| sh`、`\| tail -f` | ❌ 会写文件 / 再起程序 |
| 同上，改成 `; echo done`、`&& echo done` | ❌ 第二条命令 |
| 同上，写 `\| tail $(echo 3)` | ❌ 命令替换 |

`2>&1 | tail -12` 是模型最常写的形态，现在会命中。代价只有一个：**模型看到的退出码变成 `tail` 的**。`tail` 成功而 `lark-cli` 失败时，只能靠输出和 stderr 判断；这类"管道遮住退出码"的写法因此仍不推荐，只是不再因为写法弹窗。

### 不需要每个仓库都写 AGENTS.md

插件自己把这条约束告诉模型：它注册一个系统提示段（`tool:bash:auto-approval`，紧跟在 `tool:bash` 之后），内容由当前规则生成 —— 命中哪些命令、认哪几种写法、哪些写法会落回审批。

- 装到哪个 profile 就带到哪个 profile，不用在每个仓库的 `AGENTS.md` 里重复；
- 在设置页改规则后，下一轮对话的提示就跟着变，不需要重启；
- 不想让它占系统提示就设 `promptHint: false`。提示只是提示，真正的判断仍在匹配器：模型写错形态只会多弹一次窗，不会多放行。

`AGENTS.md` 仍然可以写，但它是"项目偏好"，不再是本插件的必要配置。

### 窄根与「任意写法」（`roots` / `shape`）

形状检查和可写根的宽度是**互相补偿**的：根越宽，写法必须越严；根越窄，写法可以越松。两件事可以分开做。

**第一步，只收窄根（不放松任何写法）**：

```yaml
- name: lark-cli
  command: lark-cli
  roots:                                  # 只让这两个目录可写，$HOME 其余部分不动
    - ~/.lark-cli
    - ~/Library/Application Support/lark-cli
  shape: strict                           # 默认值，仍按上面的写法表
```

`~/.zshrc`、`~/Library/LaunchAgents/`、`~/.ssh` 都不再在可写范围里。**这是本插件目前性价比最高的一次收紧**，行为上没有任何放松。

**第二步，需要复杂写法时再打开 `shape: any`**：

```yaml
- name: lark-cli
  command: lark-cli
  roots: [~/.lark-cli, ~/Library/Application Support/lark-cli]
  shape: any
```

这时插件不再解析语法，命中条件退化为「命令行里出现了这个程序名」（引号内的整体算一个词，注释和重定向目标不算）。
`| tee`、`;`、`&&`、`for` 循环、`xargs` 都能命中；写仍然被内核限制在列出的根里。

仍然拒绝的几种：

- `./lark-cli`、`/tmp/x/lark-cli` 这类**模型自己指定的路径**（影子攻击）；
- `bash -c 'lark-cli …'`：引号内是一个词，不会被当作程序名（宁可多弹一次窗）；
- `shape: any` 配 `$HOME`（或 `$HOME` 的祖先目录）：加载时直接丢弃该规则并告警 —— 「任意写法」只剩可写根这一道边界，把整个家目录交给它等于「任何命令都能写家目录」。

用 `any` 之前请确认这四条代价：

1. **目录必须列全**：漏一个，命令会在**执行中**被 `[sandbox: file access denied …]` 拒，进而触发模型升级授权 —— 正是本插件要消灭的那条链路，频率取决于你列得准不准。
2. **名字匹配不再是 realpath 校验**：`shape: any` 只看字符串，`PATH` 影子检查也不再适用，安全边界只剩内核的可写根。
3. **app 私有目录也是持久化面**：如果该 CLI 会加载目录里的配置或 hook，写进去等于下次执行代码。要按 app 判断，不能默认「窄 = 安全」。
4. **overlay 不可用时额外根不生效**：POSIX 上授权始终是「工作区 + 列出的根」，overlay 没装上时只有工作区可写，Host 日志会告警一次并在放行行标记 `(root overlay inactive)`；不会退化成「只给第一个根」。
5. **Windows**：ACL 策略只能表达一个根，多根规则取第一个并告警。

建议顺序：先 `roots` + `strict` 跑一段时间，确认没有新的 `file access denied`，再把确实需要复杂写法的规则单独改成 `any`。

## 安装

要求：DSH Desktop（带 profile），macOS 或 Linux，bash 路径。

### 从 npm 安装

包已发布到 npm，推荐直接安装：

```text
plugin_manager(action="install_bundle", target="dsh-whitelist-auto-approval")
```

或在 Plugins 页 **Add plugin** 里填包名 `dsh-whitelist-auto-approval`（可带版本，如 `dsh-whitelist-auto-approval@0.4.0`）。

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

默认白名单是 `lark-cli` 和 `gh`。UI 覆盖不到的字段（`audit`、`upgradeFromReadOnly`、`extraPath`、`allowCdPrefix`、`promptHint`、`trace`）或需要精调顺序时，仍可直接编辑 profile 的 patch 文件（`~/.dsh/profiles/<profile>/cordis.patch.yml`），覆盖本插件的 row——**同 id 的 `config` 是整段替换，不是合并**，所以要把需要的字段写全：

```yaml
- id: bash-sandbox-auto-approval
  config:
    audit: true                 # 每次放行写一行 Host 日志
    upgradeFromReadOnly: false  # 会话在 read-only 时不越权
    extraPath: []               # PATH 里找不到命令时，额外搜索的目录
    allowCdPrefix: true         # 认 `cd <目录> && <白名单命令>` 这种写法
    promptHint: true            # 在系统提示里声明命令与可命中的写法（false 关闭）
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
      - name: lark-cli-narrow
        command: lark-cli
        roots:                  # 多根：工作区之外只有这两个目录可写
          - ~/.lark-cli
          - ~/Library/Application Support/lark-cli
        shape: any              # 不再解析写法；只有根足够窄时才这么写
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 裸命令名或绝对路径 |
| `name` | 否 | 日志里的标签，默认取 `command` |
| `grant` | 否 | `home`（默认）/ `custom` / `roots` / `full` |
| `root` | `custom` 时必填 | 绝对路径或 `~/...` |
| `roots` | 否 | 可写根数组（绝对路径或 `~/...`），优先于 `grant` / `root` |
| `shape` | 否 | `strict`（默认）或 `any`：是否解析命令写法 |
| `deny` | 否 | 正则数组，作用于原始命令串；任一命中即不放行 |
| `allow` | 否 | 正则数组；非空时必须命中其一才放行 |

`deny` / `allow` 匹配的始终是**原始整条命令串**（含 `cd` 前缀），所以锚在开头写死的
`allow`（如 `^lark-cli`）不会命中 `cd /x && lark-cli ...` 这种写法——这是偏保守的一侧：
不命中只会多弹一次窗，不会多放行一条命令。

顶层开关（不在规则里）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowCdPrefix` | `true` | 接受一个开头的 `cd <目录> &&`：剥掉前缀、按 `cd` 目标解析并继续匹配。设为 `false` 不再识别 `cd` 前缀（写中立的管道仍生效） |
| `promptHint` | `true` | 在系统提示里声明白名单命令和被接受的写法（见上文「不需要每个仓库都写 AGENTS.md」）；设为 `false` 不注册该提示段 |
| `audit` | `true` | 每次放行写一行 Host 日志 |
| `upgradeFromReadOnly` | `false` | 会话处于 `read-only` 时不越权放行 |
| `extraPath` | `[]` | PATH 外额外搜索目录（GUI 启动的进程 PATH 可能很短） |
| `trace` | 未设置 | 可选 JSONL，记录每次判定（未命中原因 / 命中的规则 / 可写根） |

`grant` / `roots` 的区别（macOS/Linux 上有 overlay 时都是**追加**根，会话工作区保持可写）：

| 值 | 实际策略 | 适用 |
|---|---|---|
| `home` | 工作区 + `$HOME` | 写自己家目录、同时还要往工作区落盘的 CLI |
| `custom` | 工作区 + `root` | 只需要单个目录时收紧 |
| `roots: [...]` | 工作区 + 列出的每个目录 | 最推荐的形态：把 `$HOME` 收窄到 app 私有目录 |
| `full` | `danger-full-access` | 确实需要无约束（等于把"批准完全权限"自动化） |

macOS/Linux 上授权**永远是「工作区 + 列出的根」**，不会替换成单个根：overlay 没装上时额外根只是
不生效（命令仍拿得到工作区），Host 日志告警一次，放行行标记 `(root overlay inactive)` —— 这样失败的
表现是「沙箱拒绝某次写入」，而不是「可写根被悄悄换成了另一个目录」。
Windows 的 ACL 策略只能表达一个根：`home` 换成 `$HOME`，多根规则取第一个并告警一次。

手改 YAML 后需要重启 DSH 生效；通过 UI 保存则即时生效。

> 第一次在 UI 里保存会生成一份 profile override（包含当前完整 config）。之后 bundle 自带的默认规则变化不会再自动覆盖这份 override；需要回到默认时，删除 profile patch 里 `bash-sandbox-auto-approval` 的 `config` 段即可。

## 验证

在 `workspace-write` 会话里逐条执行。`;`、`&&`、`> 文件`、`| tee` 都不会命中；单个开头的
`cd <目录> &&`、`2>&1`、`>/dev/null`、`| tail -N`、`| head -N`、`| wc` 会被识别：

```bash
lark-cli task +get-my-tasks                          # 期望成功，且没有授权弹窗
lark-cli task +get-my-tasks 2>&1 | tail -5           # 期望同样成功：写中立的管道被识别
gh api user --jq .login                              # 期望返回你的用户名
touch ~/whitelist-probe                              # 期望仍被拒：file access denied under workspace-write
cd ~ && lark-cli task +get-my-tasks                  # 期望同样成功：单个 cd 前缀被识别
lark-cli task +get-my-tasks | tee /tmp/out           # 期望被拒并弹窗：tee 会写文件
```

最后两条是对照组：插件只放行白名单和写中立的管道，没有把会话变成完全权限。

macOS/Linux 上，命中命令的沙箱同时保留工作区：同一轮里刷新 token 再把下载/导出写回
`./` 不会被拒绝（`home` 现在是"工作区 + `$HOME`"两个根）。

UI 验证：在 **设置 → 命令自动放行**（或 Plugins 行页）添加或删除一条规则并保存，然后**立刻**执行上面的命令（不需要重启）；保存后的下一次 bash 调用就会使用新规则。

## 安全边界（请务必读）

1. **沙箱本来就不限制读和网络。** `workspace-write` 下任何命令都能读 `~/.ssh`、`~/.lark-cli` 里的 token。本插件增加的是**写**的能力，不是读的隔离。
2. **`home` 授权 = 可写整个家目录**，包括 `~/.zshrc`、`~/Library/LaunchAgents/`、`~/.ssh/authorized_keys`。对一个被提示注入的模型，这是持久化风险。**能用 `roots` 收窄就别用 `home`。**
3. **白名单信任的是整个程序**，包括它自己的下载/导出子命令（例如 `lark-cli drive +download --output <路径>`）。需要更严就用 `deny` 把高危子命令排除。
4. **`full` 等于自动批准完全权限**，只在明确需要时用。
5. **别名/包装器不放行**：`alias`、shell 函数、`env`、`timeout`、`npx` 包一层的写法都不会命中，会正常弹窗。这是刻意的。
6. 它只回答"这条命令的沙箱边界能不能放宽"，**不回答"这条命令该不该跑"**。
7. **管道后段与主命令同一信任级别**：`tail` / `head` / `wc` 也按 `PATH` + `realpath` 解析，只是不接受路径参数、不认会写文件或再起程序的开关；能劫持 PATH 的攻击者本来就能劫持主命令。
8. **`shape: any` 只剩内核这一道边界**：命中是字符串级的（`echo lark-cli` 也算命中），`PATH` 影子检查失效；安全全靠可写根是否够窄。
9. **UI 不新增权限面**：保存写入的就是 profile 的 `cordis.patch.yml`，与手工编辑同一份文件；没有新增 HTTP 路由或 agent 工具。`full` 规则需要用户显式确认。

## 已知限制

- **macOS/Linux 两个可写根，Windows 一个**：macOS/Linux 上 `home` 会保留会话工作区并追加 `$HOME`；Windows（或 provider runner 无法识别）仍然会覆盖 `workspaceRoot`，命中命令会失去对工作区的写权限。
- **overlay 是尽力而为**：它只是在官方 runner 的 profile/argv 上追加；runner 不认识、argv 形状变了、路径不存在，都会原样返回并告警一次。结果是"这次没加上根"，不是"放宽了沙箱"。
- **`write`/`edit` 不覆盖**：overlay 只放宽被沙箱约束的命令；用文件工具写 `$HOME` 仍按会话策略走。
- **不要和接管 `sandbox` provider 的插件混用**：overlay 的 allow 追加在最终 argv/profile 末尾；如果别的插件在同一 profile 里追加了自己的 deny，顺序可能反过来。本插件假设 provider 是官方 `dsh-sandbox-local`。
- **只处理 bash**：Windows 上 DSH 走 `pwsh-sandbox`；overlay 在 win32 不安装，`home` 退回替换根。`cd` 前缀也只认 POSIX 的 `&&`，pwsh 的 `cd x; cmd` 仍不命中。
- **`cd` 前缀只认一个**：`cd a && cd b && …`、`pushd`、`(cd a && …)` 都不命中；嵌套目录切换直接用 bash 工具的 `workdir`。
- **管道只认写中立的形态**：`| tail` / `| head` / `| wc` 且参数只有数字时命中；`| tee`、`| sh`、`| sed -i`、`| awk`、`| tail -f`、`> file` 这类会写文件或再起程序的形态仍落回原审批。
- **管道会改变看到的退出码**：`a | tail -12` 的退出码是 `tail` 的，`a` 失败可能被遮住；看重成败就用不带管道的写法。
- **提示段是尽力而为**：`promptHint` 只能降低模型写错形态的概率，判断仍在匹配器；模型忽略提示时只会多弹一次窗。
- **`shape: any` 的命中是字符串级的**：`echo lark-cli` 也算命中（拿到的是窄根），而 `bash -c 'lark-cli …'` 不算；注释与重定向目标不计入。
- **`shape: any` 不能配 `$HOME`**：这种规则在加载时被丢弃并告警，见上文「窄根与任意写法」。
- **多根在 Windows 上不可表达**：只取第一个根，并告警一次。
- **`roots` 漏目录 = 执行中被拒**：`custom` / `roots` 不再像 `home` 那样"够宽"，漏掉的目录会触发 sandbox denial，进而可能走到升级授权。
- **依赖 `ctx.shell.resolve()` 这个方法名**：DSH 升级若改变执行器契约，插件会退化为"不放行"，不会破坏执行。
- **UI 只管理 `rules`**：`audit`、`upgradeFromReadOnly`、`extraPath`、`trace` 仍在 YAML；同一 `command` 的重复规则在 UI 中被阻止（YAML 仍可按顺序手写）。
- **不能替代人工判断**。

## 目录

```
dsh-whitelist-auto-approval/
├── package.json          # bundle + dsh.client 清单
├── cordis.patch.yml      # 插入 bash-sandbox-auto-approval 这一行
├── index.js              # 装饰 ctx.shell.resolve()，读取 volatile rules，注册提示段
├── overlay.js            # 装饰 ctx.sandbox.confine()，按 runner 追加额外可写根
├── schema.js             # Config schema（rules 为 volatile）
├── client.js             # Web UI：Settings 页 + plugins.row.config 规则表
├── matcher.js            # 管道词法分析 / 写中立判定 / cd 前缀 / PATH 解析 / 规则匹配
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
