# AGENTS.md · dsh-jobs-autoclose

> 面向要读/改这个插件的 agent。使用者自述在 `README.md`。只写占位符。

## 1. 30 秒看懂

**客户端半做决策、宿主半极薄**的 DSH 插件。两个方向：

- **关闭**（v0.2.x）：轮结束（agent idle）后盯本条会话的后台任务，全部停完且那一页「可证明是自动打开的」→ 关掉「任务管理」页；用户碰过 / 进入新一轮 → 停表。
- **打开**（v0.3.0）：轮结束、**活着的只有子代理**、且本轮没产生过后台任务 → **打开**那一页（面板的两条自动打开触发器都不响的缝里），让用户看得见；每轮最多一次，用户关掉就不再开。

## 2. 文件

| 路径 | 是什么 |
|---|---|
| `lib/client.js` | **决策全在这里**（`window.__ModuleLoader__.load` 手写 bundle；不 require 任何平台模块） |
| `lib/index.js` | 宿主半：只提供 `/api/jobs-autoclose/report`（POST 写 / GET 读 / 落盘 `$DSH_HOME/jobs-autoclose/report.json`） |
| `.smoke/client-test.mjs` | 客户端半离线冒烟（loader 同形装载 + 真源码 + 桩 ctx，**97 断言**；桩按实测契约搭。第 3 版新增 57 条：守卫链七项、边沿触发、fail-closed、自我关闭守卫、打开抛错、缺能力、`self-opened` 终检） |
| `.smoke/fixtures/client-no-open.mjs` | **客户端反向控制样本**：把第 3 版的打开动作整体删除的冻结副本。用 `JA_CLIENT_MODULE` 指向它时**必须 FAILED 34 / 97（63 passed）**——它若变绿说明新用例被削弱了 |
| `.smoke/host-test.mjs` | 宿主半离线冒烟（真 `Request` 打真路由 + 真落盘，25 断言） |
| `.smoke/fixtures/host-legacy-buggy.mjs` | **反向控制样本**：冻结的旧实现，故意保留两个坑。用 `JA_HOST_MODULE` 指向它时**必须 FAILED**——它若变绿说明测试被削弱了 |

## 3. 契约速查（运行时接口出处，本机 0.1.5-rc.3 实测）

| 主题 | 约定 |
|---|---|
| **会话列表快照** | `ctx.sessions.list.getSnapshot()` = **`{ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress }`**。⚠️ **行在 `byId`（按 sessionId 索引的对象）、顺序在 `ids`**；行形 `{ id, displayTitle, running:boolean, blank, updatedAt, completed?, title?, cwd?, parentId?, origin? }` —— 行 id 字段是 **`id`**，「忙」是 **`running` 布尔**。**两处字面出处**：实机自检 `shapes.listTopKeys` 亲口报出这七个键；源码 `@deepseek-ai/dsh-api-session-controller/lib/client.js:3416-3424` 的 `this.list.set({ ids, byId, … })`、行形在 `:3367-3379`。🚨 **同一个包里有两套投影**：`manager.getListSnapshot()`（`:2912-2921`）返回的是 `{ items, sessionId, running, … }` —— **那是另一套**，写成 `s.items` / `s.sessions` 都读不到行（空数组、不抛异常） |
| 任务流 | 同上的 `jobsBySession[sessionId]` → `job[]`（推送镜像；`dsh-better-sidebar` 用它，见其 client.js:15721 / :12004）。**活着的判据逐字对齐面板的 `isJobLive`（:11129-11131）**：`status === "running" \|\| status === "stopping"` |
| 侧边栏状态 | `ctx.betterSidebar.getSnapshot()`（能力 `stateSubscription`，其 client.js:1209）；`ctx.provide("betterSidebar", …)` 在 :18753 |
| **任务管理页在哪** | **不在** betterSidebar 自己的面板树里：`activateTasksPage`（:15546）走 `betterSidebar.openTab({type:"subagent"})`，而 `openTab` 在 `seed.target !== "bottom"` 时**转交原生右栏**（:1376；surface 恒被 setSurface :18756）。它是 **DSH 原生右栏的 native tab**，kind = descriptor id = `"subagent"`（:17034 `tabs.register({kind: descriptor.id})` + :15723/:15759 两处 `isTabEnabled("subagent")` 交叉确认） |
| **关它的 API** | `ctx.sidebarRight`（`@deepseek-ai/dsh-client-ui-sidebar-right`，类型见其 `lib/types/client/service.d.ts`）：`active(): TabRecord\|undefined` · `isExpanded(): boolean` · `close(tabId)` · `closeIn(sessionId, tabId)` · `toggleExpanded()`。⚠️ `close` **保留唯一 docked 页**（`canCloseTab`）→ 关不掉时退一步收栏 |
| **打开它的 API** | `ctx.sidebarRight.openTab(kind, options?)`（公开面 `service.d.ts:125`；实现 `:1231-1234` → `placeTab :1276-1285` → `place :1287-1301`）。`kind = "subagent"`。**本机契约下它必然展开右栏并让该页成为活动页**（store `openContent` `:501` 的 `planSetExpanded(state, true)`；面板注释 `:15533-15535`「The host expands on every open … offers no option to suppress it」），面板自己的 `activateTasksPage`（`:15546-15554`）就把它叫 “Activate the Tasks page”。所以插件**不额外调任何焦点 API**、不传 `paneId`/`replaceTab`/`revealIfOpened`、不关闭 / 不替换任何已有页；前后活动页如实记进 `lastOpenDecision.focusBefore/focusAfter` |
| **子代理在哪** | `subagentsByParent[父会话]`（源码 `dsh-api-session-controller/lib/client.js:2918` `Object.fromEntries(this.catalogs)`）。catalog 形 `:2416-2434`：`{ entries, parentAvailable?, state: "loading"|"ready"|"error", error }`；行形 `:2856-2864`：`{ kind:"child", id, label?, hasChildren?, activity? }`。**`activity` 取值域**来自 `:2809`（`running ? "running" : "inactive"`），并被 `:3396` 用作 `running: child.activity === "running"`。冗余来源 = 会话行 `origin === "subagent"` + `parentId` + `running` 布尔（`dsh-better-sidebar` `:11092-11097` `directSubagentCount` / `:11062`） |
| **别用** `betterSidebar.closeTab` | 它的签名是 `(tabId, scope?)`（:1470），**不是** `(paneId, tabId)`；且先走 native surface 的 `records` 表，只认它自己注册的 tab |
| **快照形状** | `betterSidebar.getSnapshot()` = `{ sessionId, state, prefs }`（:919-923 / :933-935）。`state.bottomSplits`/`state.bottomOpen` 是插件**自己的底部工作台**（不含任务管理页）；`prefs` 才有 `autoOpenJobs` / `autoOpenSubagent`（默认 true，:44-45） |
| ⚠️ **快照里没有任何时间戳** | `openedAt` / `activatedAt` / `createdAt` 在侧栏源码里**全无命中**。所以「用自动打开的时间签名当所有权代理」在结构上不可能成立（第 1 版就栽在这） |
| 自动打开来源 | 面板自身的 `autoOpenJobs` / `autoOpenSubagent` 偏好（:44-45 / :13815-13819 / 逻辑 :15741-）；job 触发器：`detectNewJob` + `autoOpenJobs` + `isTabEnabled("subagent")`（:15752-15766），**无防抖**（subagent 那条有 500 ms 防抖 :15521）。**不是本插件打开的**——所有权靠「激活跳变 + 无用户输入 + 同窗口有新任务 id」三者合证 |
| 轮次判定 | 会话行 `running` 布尔的跳变：**忙→闲 = 轮结束（arm）**，**闲→忙 = 新一轮**（曾：误读为 `status` 字符串的 `idle` ↔ 非 idle）。**新一轮必须用「先判关闭再停表」的顺序**，因为完成通知会在空闲上自己开一轮（`dsh-tool-jobs` 默认 `completionDelivery: "wakeup"`，lib/index.js:170/221） |
| 报告怎么读 | `/api/jobs-autoclose/report` 从 shell 里 curl 会吃 **401**（`/api/**` 要会话令牌）→ 宿主半同时把同一份报告落盘到 **`$DSH_HOME/jobs-autoclose/report.json`**，直接读那个文件 |
| **Fetch 路由契约** | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`。`requestBody: "buffered"` 只表示**宿主已把整包收进内存**，`fetch(request)` 收到的仍是标准 `Request`——**`request.body` 是 ReadableStream**，正文必须 `await request.text()` / `request.json()`；返回值必须是**真 `Response`**（`{ content: [...] }` 那套是 RPC 通道的形，Fetch 路由不认）。出处：`@deepseek-ai/dsh-client-connection/lib/index.js:570-601`，官方同款见 `dsh-client-ui-deliverables/lib/index.js:34-39`（`Response.json(...)`） |

## 4. 改完必跑（离线，不碰任何工作区）

```powershell
cd <工作区根>\plugins\dsh-jobs-autoclose
node --check lib/index.js ; node --check lib/client.js
node .smoke/client-test.mjs        # 客户端半：期望 ALL OK (97 assertions)
node .smoke/host-test.mjs          # 宿主半：期望 ALL OK (25 assertions)
# 反向控制①（宿主半）：必须 FAILED (13 passed, 12 failed)
$env:JA_HOST_MODULE = "<插件目录>\.smoke\fixtures\host-legacy-buggy.mjs"; node .smoke/host-test.mjs
# 反向控制②（客户端半，第 3 版）：必须 FAILED 34 / 97（63 passed）
$env:JA_CLIENT_MODULE = "<插件目录>\.smoke\fixtures\client-no-open.mjs"; node .smoke/client-test.mjs
```

⚠️ 冒烟脚本末尾有 `process.exit`：客户端冒烟用例 12 会起轮询定时器，不硬退出会吊住事件循环（实测把整个 node 卡住、连工具调用都被当成超时提升成了后台任务）。

## 5. 红线

1. **绝不抛**：客户端半抛异常会连累整块 UI；所有入口 try/catch（`apply` 里已有最外层兜底）。
2. **无证据不关**：只有「**激活跳变** + 激活前无用户输入 + 同窗口内有新任务 id + `prefs.autoOpenJobs !== false` + `isTabEnabled("subagent") !== false` + 无活跃项」全部成立才动手；缺任何一条都只上报（fail-closed）。后两条是面板自己开页的守卫，逐条对齐后「是不是面板开的」才可证。
3. **不要把「agent 又开始跑」当成新一轮**：那是完成通知自己唤醒的，会抢掉最后一次关闭。
4. **客户端 bundle 的 `id` 必须是包名**（`dsh-jobs-autoclose`）：client-modules 按 bundle 路径推出期望 id，对不上就**整棵插件树装载失败**（实测：`bundle … loaded without registering "dsh-jobs-autoclose" via __ModuleLoader__.load`）。别把宿主半的插件 `name`（`jobs-autoclose`）当 id —— 对照 `plugins/dsh-sandbox-sweep/lib/client.js:17` 写的是 `dsh-sandbox-sweep`。
5. 只 `window.__ModuleLoader__.load({ id, factory })`，不 require 平台模块表以外的 id（本插件一个都不需要）。
6. **Fetch 路由的两条形**（`lib/index.js` 里已写注释，改之前先看 §3 那行）：
   `request.body` 是流不是字符串（`JSON.parse(request.body)` → `"[object ReadableStream]"`，
   实机曾把整份自检报告写成一行 parseError）；返回值要 `Response`，不要 `{ content: [...] }`。
7. **别照着自己想象的接口形状写代码** —— 已栽**三次**，每次都是"离线全绿、实机静默"（错形状 = 空数组/`undefined`，不抛异常）：
   · **第 1 版**：左侧栏快照里 tab 带 `openedAt`、任务页 kind 叫 `jobs`、关页用 `closeTab(paneId, tabId)` —— 三处全错；
   · **第 2 版**：会话列表写成 `{ sessions: [...] }`、「忙」读成 `row.status` 字符串、会话 id 读成 `row.id` —— 三处全错；
   · **第 3 版（v0.2.1）**：会话列表改读 `items`……**仍是错的**，那是 `manager.getListSnapshot()` 的投影；
     `ctx.sessions.list.getSnapshot()` 的真键是 **`ids` / `byId`**，行 id 字段是 **`id`**（见 §3）。
   **纪律**：① 改这一半之前先读 §3 引的行号；② 桩的形状**必须**来自「实机自检亲口报出的键」或「该方法的源码行」，
   **不能**来自相邻的同类函数——**同一个包里就可能有两套投影**，读对包名不够，要读对**方法**；
   ③ 判别窍门：**离线绿但实机"什么都没发生"，先怀疑形状读错，而不是逻辑错**。

8. **首次观察只取基线**：装载前就开着的页不算「激活跳变」（面板自己也是这条纪律
   :15749-15750），否则第一拍可能误关用户早就开着的页。

9. **第 3 版的「打开」三条纪律**（与关闭路径互不打架的保证）：
   · **只走** `ctx.sidebarRight.openTab("subagent")`，**不传** placement、**不额外调任何焦点 API**
     （`focus`/`focusTab`/`toggleExpanded` 一个都不碰）、**不关闭/不替换**任何已有页；
   · **边沿触发**：每次「轮结束」跃迁最多尝试一次（`armed.openState` 从 `idle` 走出去就不回头），
     用户关掉它 → 本轮不再开；**别把它改成电平触发**（会变成每隔一拍就抢你一次焦点）；
   · **打开造成的信号必须打 `bySelf`**，且关闭路径开头有 `self-opened` 守卫 ——
     不许出现「刚打开就被自己关掉」，也不许把自己的动作当成「面板自动打开」的证据。
   另：`armIfActive` 的**关闭分支保持原样**（只加不减）；打开分支只在「无 live job」时才进。

## 5.1 实机可观测性

**每次状态跃迁都推一份报告**（mount / arm / 任务页激活跳变 / disarm / 关闭），落盘到
`$DSH_HOME/jobs-autoclose/report.json`。这是刻意的：只有 mount + 关闭才推的话，
一次"什么都没发生"的实机测试**不留任何证据**（2026-09-29 就是这么白跑一轮的）。
所以 `decisions` 里有完整的 `session … running: true → false` / `new job id(s): …` /
`tasks page became active …` / `armed for …` / `disarm: …` 时间线。

**第 3 版新增两种 event**（时间线格式不变，只多一个 `event` 字段；不传 event 的行**逐字照旧**）：

- `open-tasks-page` —— 成功打开；message 里列出「是哪些守卫让它通过」（约束 5 要求的「写清哪一个守卫」）；
- `open-tasks-page-skipped` —— 被否 / 抛错 / 用户关掉后「本轮不再打开」；

完整分量同时进 `report.lastOpenDecision`（`opened` / `reason` / `path` / `guards` 七项 / `liveSubagents` /
`focusBefore` / `focusAfter` / `disarmReason`）。

## 6. 实机验证清单（装完 + 重启后）

1. 读自检报告：**直接读文件** `$DSH_HOME/jobs-autoclose/report.json`（curl 那条会吃 401）→ 看 `caps` / `shapes` / `decisions`；
2. 起一条超时转后台的命令（`Start-Sleep -Seconds 60`，`timeoutMs: 5000`）→ 面板自动弹出并**激活**任务页
   （前提：`prefs.autoOpenJobs` 为真 + 任务管理页未被禁用 + 原生右栏 `ctx.sidebarRight` 在位）；
3. 等命令自然结束 → 若该页确为自动打开，应自动关闭（关不掉则退一步收栏）；若没关，
   报告里的 `lastDecision` + `decisions` 会写明原因（`no-page` / `not-auto` / `close-refused` / `no-api`，
   以及 `allowed`/`freshJob`/`noUser` 三个分量各自真假）；
4. 反向：手动打开任务页 → 等任务结束 → **不应**被关；
5. 反向：监听期内直接发新消息 → 立即停表，且不再有任何关闭动作。

**第 3 版（v0.3.0）打开行为的实机核对 —— 待跑，步骤见 `README.md`「第 3 版实机核对步骤」：**

6. 让**子代理**跑起来（本轮**不要**产生后台任务，否则走的是后台任务那条触发器），主代理先收掉回复 →
   期望 `open tasks page via sidebarRight.openTab("subagent") → tab=…`、`lastOpenDecision.opened: true`、
   七项 `guards` 全真；把它关掉 → `本轮不再打开`；子代理跑完 → `disarm: subagent-settled` 且**没有**
   `closed tasks page`（那一页是本插件开的，不是面板开的）。
7. 若报告里出现 `open skipped (… subagent-unknown)` / `判定数据缺失/结构不认识 → 不监听`，
   说明本机形状与 §3 记的不符 —— 把 `report.json` 的 `shapes` 段（`subagentsTopKeys` / `catalogKeys` /
   `catalogState` / `catalogEntryKeys` / `liveSubagents`）贴回来，**不要**照着想象改判定。

### 6.1 实机结论（2026-09-29，v0.2.2）

**第 2/3/5 条已实机通过**，时间线与判据见 `README.md`「实机决策时间线」。关键数字：

- 关掉的是 `tab=tab2`（`kind: subagent`、`title: 任务管理`、`expanded: true`）→ `close()` 正常生效，
  不是「唯一 docked 页被保留」那条退路；
- `lastDecision` 三个分量 `allowed` / `freshJob` / `noUser` **同时为真**才动手；
- 签名窗口 `|sig.at − newJobAt| = 15 ms` → 面板的 job 触发器（:15752-15766，**无防抖**）与页激活确实同拍；
- `signalAgeMs: 55557` → 信号虽然旧了 55 s，但判定用的是**两个事件的相对间隔**而非「相对现在多久」，
  所以整轮盯守期间信号一直有效（这是刻意的：所有权是「谁开的」，与「多久以前开的」无关）。

**第 4 条也已实机通过（2026-09-29）**：作者自己点开任务页 → `tasks page became active (user)` →
随后 15 s 任务提升、arm、任务结束 → `settled, but page not provably auto-opened (user touched it) → 不关`
→ `disarm: not-auto`，**没有** `closed tasks page` 行，页面未被动。

值得记的两点：① `noUser: false` 与 `freshJob: false` **互为冗余**，任一条都能否决关闭；
② `signalAgeMs: 81631` 仍被采信 —— 判定用的是**事件属性**（谁开的），时效只在 `freshJob` 那条**相对间隔**上生效。

至此 §6 清单第 2/3/4/5 条全部实机通过（时间线见 `README.md` 的两节「实机…时间线」）。

## 7. 安装 / 生效 / 卸载

- 安装：符号链接 + `cordis.patch.yml` 的 `- insert` 段；**生效需重启实例**（宿主半与客户端 bundle 都在启动时装载）。
- 卸载：删 insert 段 + 删链接。
