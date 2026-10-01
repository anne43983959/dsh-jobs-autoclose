# dsh-jobs-autoclose

> **一轮结束后，替你把「任务管理」页收掉**：等本轮的后台任务与子代理全部停下，若那一页不是你自己打开的，就自动关闭；你碰过它、或开始新一轮，立刻停止监听。
>
> **反过来也管**（v0.3.0）：主代理回复结束、**还在跑的是子代理而不是后台任务**时，那一页不会自己出现 —— 插件替你把「任务管理」页**打开**，让你看得见还有东西在跑。每轮最多开一次；你把它关了就不再烦你。

## ⚠️ 版本支持（2026-10-01 实测，**先读这一段**）

| DSH | 可用性 | 依据 |
|---|---|---|
| **0.1.5-rc.3** | ✅ **完整可用** | 能力自检 18/18 全 `true` |
| **0.1.7-rc.2** | ❌ **不可用** | `ctx.get("sidebarRight")` 拿不到 ⇒ `active` / `isExpanded` / `close` / `closeIn` / `toggleExpanded` / `openTab` / `focus` **全部 `false`** |

**为什么这决定了可用性**：本插件的两条核心判据里，「这一页是不是你自己打开的」（`sidebarRight.active`）与「把页打开/关掉」（`openTab` / `close` / `toggleExpanded`）都走 **`sidebarRight` 服务**；该服务在 0.1.7 线上不存在。缺了它，插件**无法区分「用户手动打开」与「面板自动打开」**，强行运行就会误关你自己打开的页面 —— 所以它在这条线上是 **fail-closed 地不工作**，而不是「能跑但不准」。

实测数据来自两个 home 里插件**自己上报**的能力自检（`$DSH_HOME/jobs-autoclose/report.json`）：

```
0.1.7-rc.2 caps: sidebar=true snapshot=true isTabEnabled=true closeTab=true   ← betterSidebar 这一路仍可用
                sidebarRight=false active=false isExpanded=false close=false closeIn=false
                toggleExpanded=false openTab=false focus=false              ← sidebarRight 这一路全灭
0.1.5-rc.3 caps: sidebarRight=true active=true isExpanded=true close=true closeIn=true
                toggleExpanded=true openTab=true focus=true                ← 全绿
```

> `package.json` 的 `dsh.compatibility.runtime` 原写 `>=0.1.1-rc.1 <0.2.0`（2026-09-30 后补），**与实测不符**；已按实测收窄为 `<0.1.7`。以本表为准。
> 在 0.1.7 线请**不要启用**本插件（已从 `homes/0.1.7-rc.2` 的 profile 卸载，并清掉 `cordis.patch.yml` 里的 insert 条目）。

---
## 需求口径（作者定义，实现严格照此）

- **一轮** = 从你发消息到助手产出终局回复、会话回到等待输入（**idle**）的整个交换；**不是**中间的一次 LLM 调用/一个步骤。
- 因此监听窗口只在 **idle 期**：轮内助手还持有这些任务（随时会 `job_output`/`job_kill`），自动关 UI 只会跟它抢方向盘。
- 起监听：轮结束时若仍有活跃任务 → 记下基线开始盯。
- 停止监听：① 全清空并已关闭；② 用户碰过那一页；③ **用户进入新一轮**。

## 需求口径（v0.3.0 新增的一半：把页**打开**）

面板自己只有两条自动打开触发器：**新后台任务**（`detectNewJob`）与**子代理 0 → N**（`detectNewDirectSubagent`）。
当主代理回复结束时，**活着的只有子代理、本轮又没产生过后台任务**，那一页谁也不会去开，用户就看不到
还有东西在跑。本插件补这条缝：

- **触发**：主代理完成一轮回复（会话行 `running: true → false`）且该会话无活着的后台任务；
- **动作**：走 `ctx.sidebarRight.openTab("subagent")`（本机唯一真实打开路径）把任务管理页打开；
- **边沿触发**：每次「完成一轮回复」的跃迁**最多尝试一次**；你随后把它关掉，**本轮不再开**（防骚扰优先于「一定要让你看见」）；
- **fail-closed**：守卫链任何一条不成立、或判定数据读不到，都只上报、不动 UI。

> 打开与关闭**时间窗天然互斥**：关闭只在「本轮全停之后」判，而打开发生在「还有子代理活着」时。
> 实现上还有两道冗余：① 打开那一刻就把信号标成 `bySelf`，关闭判定据此否决（不把自己的动作当成「面板自动打开」）；
> ② 关闭路径开头有一条 `self-opened` 守卫 —— 本插件自己开的页**绝不自我关闭**。

## 打开前的守卫链（顺序即判定顺序，任一不成立都只上报）

| # | 守卫 | 不成立时 |
|---|---|---|
| G0 | `ctx.sidebarRight.openTab` 在位 | `no-api` |
| G1 | 本轮还没尝试过（**边沿**） | `already-attempted` |
| G2 | 任务管理页当前是**关的**（`tasksPage() === null`） | `page-open`（并退出监听：用户本来就看得到） |
| G3 | 打开前 `USER_TOUCH_MS`（1200 ms）内**没有用户输入** | `user-typed` |
| G4 | `prefs.autoOpenJobs !== false` 且 `isTabEnabled("subagent") !== false` | `prefs-off` / `tab-disabled` |
| G5 | 结束回合的就是**当前会话**（`openTab` 作用于 mounted seat） | `not-current-session` |
| G6 | 本会话**从未产生过后台任务**（粘性记录：任务结束就从镜像里消失了） | `had-jobs` |
| G7 | **确实有存活的子代理**（catalog 或会话行，任一可读且计数 > 0） | `no-live-subagent` / `subagent-unknown` |

存活的判据与面板的 `isJobLive` **同口径**（`running` / `stopping`）；子代理的 `activity` 在本机实测取值域是
`{"running","inactive"}`。**结构不认识 / 数据缺失 → 一律否决**（fail-closed，不把「不知道」当成「没有」）。

## 决策表

| 情形 | 动作 |
|---|---|
| 轮结束、无活跃任务 | 不监听、不动作 |
| 轮结束、有活跃任务 | 起监听（先立即判一次，之后按节律） |
| 轮结束、**无**活跃任务但**有存活子代理**、且本会话没产生过后台任务 | **打开**任务管理页（每轮最多一次，见上表守卫链） |
| 打开后你把它关了 | 本轮不再打开 |
| 打开后子代理跑完 | 退出监听，**不关**那一页（它是我开的，不是面板开的） |
| 全清空 + 该页可证明是**自动打开** | `ctx.sidebarRight.close(tabId)` → 停止监听；关不掉（唯一 docked 页被原生保留）则退一步 `toggleExpanded()` 收栏 |
| 全清空 + **不能**证明是自动打开 | **不关**（把 UI 留在原地） |
| 新一轮（含完成通知自己唤醒的那一轮） | **先判关闭、再停监听** |
| 缺少 `ctx.sidebarRight` 等能力 | 只上报，不动作（fail-soft） |

## 所有权证明：怎么知道那一页不是你开的

「任务管理」页是 **DSH 原生右栏**的页（kind = `subagent`），面板自己开它时**会激活它**。于是：

1. 盯**活动页变成 `subagent` 的跳变**；
2. 跳变前 1.2 s 内**有没有用户输入**（捕获期 `pointerdown`/`keydown`/`touchstart`/`wheel`/`click` 监听）——有就是你自己点的；
3. **同一窗口内有没有新任务 id 出现**（这正是面板 job 触发器的条件）；
4. `prefs.autoOpenJobs !== false` 且 `isTabEnabled("subagent") !== false`（面板自己的两条守卫，逐条对齐）。

四条同时成立才认定「是面板开的」。任何一条不成立 → **只上报，不动 UI**（fail-closed：宁可漏关，绝不误关）。
装载前就开着的页不算「跳变」——首次观察只取基线（面板自己也是这条纪律）。

> 第 1 版想用「自动打开的时间戳签名」当所有权代理，**结构上不可能成立**：侧栏快照里
> 压根没有任何时间戳字段（`openedAt`/`activatedAt`/`createdAt` 全无命中）。
> 详见下面「第 1 版为什么从不动作」。

## 已知限制

1. **子代理那一侧**已接入活跃判定（v0.3.0）：读 `subagentsByParent[会话].entries`（`kind: "child"` + `activity`），
   并以会话行（`origin: "subagent"` + `parentId` + `running`）作冗余兜底。
   ⚠️ 「本会话从未产生过后台任务」这条前提**只能靠观察累积**：`jobsBySession` 里任务一结束就被删掉，
   插件装载之前发生过什么无从得知 —— 所以口径是「本插件装载后未观察到该会话产生过任何后台任务」。
2. **窄屏**下自动打开是「把栏停靠回折叠态」而不是展开（面板的行为），此时 `isExpanded()` 为假、
   活动页跳变仍会发生，因此关闭路径不受影响；但「收栏」这条退路的可观测效果在窄屏上不明显。
3. 关不掉的情形依赖原生 `canCloseTab`（唯一 docked 页会被保留）；此时退一步收栏，
   若连收栏都不奏效就放弃并上报（不反复动作）。

## 运行参数

| 项 | 值 | 依据 |
|---|---|---|
| 数据获取 | **订阅优先**（`ctx.sessions.list.subscribe`），无订阅才退化为轮询 | 任务表是推送镜像 |
| 轮询基线 | 2000 ms | 面板既有节律 `JOB_POLL_MS = 2e3` / `POLL_MS = 2e3` |
| 退避 | 连续 3 拍无变化 → 5000 ms；10 拍 → 15000 ms；上限 30000 ms | `WORKTREE_RECHECK_TICKS = 15 ≈ 30 s` |
| 自动打开窗口 | 2500 ms | 「新任务 id 出现」到「页面被激活」的允许间隔（job 触发器无防抖，实测同拍） |
| 用户输入窗口 | 1200 ms | 激活前（关闭路径）/ 打开前（打开路径）这么久内有过输入即认定用户碰过 |
| 打开尝试 | 每轮 1 次（边沿） | 需求原文：「每次主代理完成一轮回复这个跃迁最多尝试打开一次」 |

## 自检上报

装载时会把自己在**真实运行时**探到的能力与形状 POST 到宿主半，**由宿主半落盘**，随时可读：

```powershell
Get-Content "$env:DSH_HOME\jobs-autoclose\report.json" -Raw
```

报告含：`caps`（`sidebarRight` / `active` / `close` / `openTab` / `focus` / `toggleExpanded` / `isTabEnabled` / `listSnapshot` 是否存在）、
`shapes`（快照顶层键、`prefs` 键、`autoOpenJobs` 值、`activeTab.kind`、`isExpanded`、会话行键、任务行键、
**`currentSessionId` / `subagentsTopKeys` / `catalogKeys` / `catalogState` / `catalogEntryKeys` / `liveSubagents`**）、
`decisions`（挂载后的决策时间线，含每次 arm/disarm 与原因）、
`lastDecision`（关闭判定的 `allowed`/`freshJob`/`noUser` 三个分量；`signal` 里多一个 `bySelf`）、
**`lastOpenDecision`**（打开判定的完整分量：`opened` / `reason` / `path` / `guards` 七项 / `liveSubagents` / `focusBefore` / `focusAfter`）。

### decisions 里的事件（v0.3.0 起，时间线格式不变，只多一个 `event` 字段）

| event | 何时写 |
|---|---|
| `open-tasks-page` | **成功打开**任务管理页；message 里逐项列出「是哪些守卫让它通过」（`guards: page=closed, input=quiet, prefs=allowed, tab=enabled, session=current, jobs=none-ever, subagents=live`） |
| `open-tasks-page-skipped` | 打开被否 / 抛错 / **本轮不再打开**；message 里写明是哪一条（或哪几条）守卫否决的 |

旧的 `{ at, message }` 行**逐字不变**（不传 `event` 时不写该字段），所以历史的实机时间线读法不受影响。

> ⚠️ 不要用 `curl http://127.0.0.1:<端口>/api/jobs-autoclose/report` 读：`/api/**` 要会话令牌，从 shell 里打会吃 **401**。落盘那份是同一份内容。

### 第 1 轮实机自检：宿主半路由曾整份失效（已修）

2026-09-29 首轮实机报告（126 B）内容只有一个错误：

```json
{ "receivedAt": "2026-09-29T09:19:34.942Z",
  "report": { "parseError": true, "raw": "[object ReadableStream]" } }
```

两个成因，都出在宿主半的 Fetch 路由：

1. **`requestBody: "buffered"` ≠ 已解析**。它只表示宿主已把整包收进内存；`fetch(request)` 收到的
   仍是标准 `Request`，`request.body` 是 **ReadableStream**。旧代码 `JSON.parse(request.body)` →
   `String(stream)` → `"[object ReadableStream]"`。正确写法：`await request.text()`。
2. **Fetch 路由必须返回真 `Response`**。旧代码返回 `{ content: [{ type: "text", … }] }`，
   那是 **RPC 通道**的响应形，Fetch 路由不认（下游拿不到 `res.json()`）。正确写法：`Response.json(value)`。

修完后离线复现锁死：`.smoke/host-test.mjs` 用真 `Request` 打真路由 —— 当前实现 **ALL OK (25 断言)**，
把 `JA_HOST_MODULE` 指向冻结的旧实现 `.smoke/fixtures/host-legacy-buggy.mjs` 则 **FAILED (13 passed, 12 failed)**，
且失败详情里逐字复现了实机那行 `{"parseError":true,"raw":"[object ReadableStream]"}`
—— 反向控制证明该测试确实在测这两条形，不是走过场。

### 第 2 版实机：会话列表读错形状，watcher 从不 arm（已修 → v0.2.1）

第 2 版上机后，宿主半路由已能把报告完整读回（1684 B 真 JSON，见下节），但**功能仍不动作**，
且报告里只有一条 `caps probed`。线索是自检里的 `shapes.sessionRowKeys: null` ——
不是列表为空，而是**读错了键**：

| 第 2 版的假设 | 实际 | 出处 |
|---|---|---|
| `getSnapshot().sessions` 是行数组 | 键是 **`items`**（没有 `sessions`） | `dsh-api-session-controller/lib/client.js:2912-2921` |
| 会话 id 是 `row.id` | 是 **`row.sessionId`** | 同上 |
| 「忙」是 `row.status` 字符串（`"idle"`） | 是 **`row.running` 布尔** | 同上 |
| 任务活着 = 状态不在终态集合里 | 面板的判据是 `status === "running" \|\| "stopping"` | `dsh-better-sidebar` :11129-11131 `isJobLive` |

后果与前一轮同类：**离线全绿、实机静默**（空数组 + `undefined`，不抛异常）。
v0.2.1 一并修掉，并把 **可观测性**也补上：**每次状态跃迁都推一份报告**
（mount / arm / 任务页激活跳变 / disarm / 关闭），所以下一轮实机测试无论成败都会留下完整时间线。

### 第 3 版实机：又读错一层投影（已修 → v0.2.2）

v0.2.1 上机后自检报出 `listTopKeys`，**真钥匙摆在眼前**：

```
["ids","byId","current","phase","subagentsByParent","jobsBySession","currentAddress"]
```

说明行在 **`byId`**（按 sessionId 索引的对象）、顺序在 `ids`，行里是 **`id`** + **`running` 布尔**。
而 v0.2.1 读的 `items` 是 **`manager.getListSnapshot()`**（`dsh-api-session-controller/lib/client.js:2912-2921`）的投影，
**不是** `ctx.sessions.list.getSnapshot()` 的形状 —— 后者在 `:3416-3424` 的 `this.list.set({ ids, byId, … })`。
同一个包里两套投影，读错哪一套都是空数组、都不抛异常。v0.2.2 按 `ids`/`byId` 重写，并把 `byIdCount`/`idsCount` 一起报出来。

这一轮能定位得这么快，靠的正是 v0.2.1 加上的 `listTopKeys` 探测 —— **可观测性本身就是修 bug 的手段**。

### 第 1 版为什么从不动作（客户端半，已重写为第 2 版）

第 1 版的离线冒烟全绿，问题出在**桩是按想象搭的**：它假设侧栏快照里每个 tab 带 `openedAt`、
假设任务页的 kind 叫 `jobs`、假设关页的 API 是 `betterSidebar.closeTab(paneId, tabId)`。
去读真实源码后，**三处全错**：

| 第 1 版的假设 | 实际 | 出处 |
|---|---|---|
| tab 上有 `openedAt`/`activatedAt` | **没有任何时间戳字段** | 侧栏源码全无命中 |
| 任务页 kind = `jobs`/`tasks`，在 `getSnapshot()` 里 | 是 **原生右栏**的 native tab，kind = `subagent`；快照里根本没有它 | `dsh-better-sidebar` :15546 / :1376 / :17034 |
| `closeTab(paneId, tabId)` | `sidebarRight.close(tabId)`；`betterSidebar.closeTab` 的签名是 `(tabId, scope?)` | :1470 |

后果：`findTasksPage` 永远返回 null → 永远走「all settled but no active tasks page → 不动」，
即**功能静默失效但从不误关**（fail-closed 兜住了，所以没造成损坏，但什么也不做）。
第 2 版按实测契约重写，并把这四条写进 `AGENTS.md` §3 与红线 §7。

## 验证状态

| 项 | 状态 |
|---|---|
| `node --check lib/index.js` / `lib/client.js` | ✅ |
| 离线冒烟 `.smoke/client-test.mjs` | ✅ **ALL OK (97 断言)**（v0.3.0；原 40 条，新增 57 条）。既有覆盖面：装载面、自检形状（含 `ids`/`byId`/`id`/`running`）、**读取面回归**（必须沿 `items` 读到 `running` 跳变并 arm）、无活跃不监听、正向（自动打开→关一次且只一次）、**反向四条**（用户碰过 / 无跳变 / 窗口对不上 / 开关关掉或页禁用）、缺 `sidebarRight` 不抛、关不掉→收栏且不循环、新一轮先关后停、无订阅退化轮询 + 输入探针可回收。新增 52 条见下节 |
| 反向控制 `.smoke/fixtures/client-no-open.mjs` | ✅ **FAILED 34 / 97（63 passed）**：把第 3 版的打开动作**整体删除**的冻结副本 —— 新用例逐条变红（`13 打开一次`、`16 不再打开`、`19 绝不自我关闭`、`20 基线正确`、`21 open-throw`、`22 no-api`、`23 self-opened` …）。它若变绿说明新用例被削弱了 |
| 离线冒烟 `.smoke/host-test.mjs` | ✅ **ALL OK (25 断言)**：真 `Request` 打路由、真 `Response`、真落盘、空正文→`{}`、坏 JSON→`parseError`+raw、GET 读回同一份 |
| 反向控制 `.smoke/fixtures/host-legacy-buggy.mjs` | ✅ **FAILED (13 passed, 12 failed)**，逐字复现实机的 `"[object ReadableStream]"` |
| 实机装载 | ✅ 客户端半已挂载并上报（插件树无装载错误，实例日志无 `loaded without registering`） |
| 实机路由 | ✅ **已修并实机验证**：`report.json` 从 126 B 的 `parseError` 变成 1684 B 完整报告 |
| 实机 `caps` / `shapes` | ✅ 全部为真，且与静态审计逐字一致：`sidebarRight`/`active`/`close`/`closeIn`/`toggleExpanded` 均存在；快照顶层键 `[sessionId, state, prefs]`；`autoOpenJobs: true`、`tabsTabEnabled: true` |
| 实机形状（v0.2.1） | ✅ `shapes.listTopKeys` 亲口报出 `ids`/`byId`/`current`/`phase`/`subagentsByParent`/`jobsBySession`/`currentAddress` → 直接定案读取面 |
| **实机正向（v0.2.2）** | ✅ **端到端通过** —— 见下节「实机决策时间线」 |
| **实机反向①：用户手动打开的页不被关** | ✅ **实机通过** —— 见下节「实机反向时间线」 |
| 实机反向②：新一轮停表 | ✅ 已实机观察：`running: false → true` 时 `evaluate()` 先跑、随后 `disarm`（顺序正确） |

### v0.3.0 离线自检：七类新用例（原始输出）

```
$ node .smoke/client-test.mjs
ALL OK (97 assertions)

$ $env:JA_CLIENT_MODULE="<插件目录>\.smoke\fixtures\client-no-open.mjs"; node .smoke/client-test.mjs
FAILED 34 / 97
  · 版本号  ->  {"actual":"0.2.2","expected":"0.3.0"}
  · 13 打开一次  ->  {"actual":0,"expected":1}
  · 13 打开的是任务管理页（kind=subagent）  ->  {"expected":"subagent"}
  · 13 decisions 里有一条 open-tasks-page 事件  ->  {"actual":0,"expected":1}
  · 13 打开事件写清了是哪几个守卫让它通过  ->  "undefined"
  · 13 lastOpenDecision.opened  ->  {"expected":true}
  · 13 报告里记下真实打开路径  ->  {"expected":"sidebarRight.openTab(\"subagent\")"}
  · 13 守卫 pageClosed / quiet / prefsAllowed / tabEnabled / sameSession / noPriorJobs / liveSubagents  ->  {"expected":true}
  · 13 报告里记下存活子代理数  ->  {"expected":1}
  · 13 存活子代理读自 catalog  ->  "undefined"
  · 14 报告写明是 user-typed 否决
  · 15 报告写明是 page-open 否决
  · 15 页已开着 → 退出监听，不空转
  · 16 先打开一次  ->  {"actual":0,"expected":1}
  · 16 用户关掉后本轮不再打开（防骚扰优先）  ->  {"actual":0,"expected":1}
  · 16 报告写明「本轮不再打开」
  · 17 报告写明是 had-jobs 否决
  · 18c catalog 认不出时会话行兜底：判定有存活子代理并打开  ->  {"actual":0,"expected":1}
  · 18c 报告写明用的是兜底来源  ->  {"actual":"undefined","expected":"rows"}
  · 19 先打开成功  ->  {"actual":0,"expected":1}
  · 20 先打开成功  ->  {"expected":true}
  · 20 用户关掉它能被立刻观测到（基线正确，没有跨拍丢失）
  · 21 报告写明是 open-throw
  · 21 lastOpenDecision 记下抛错原因  ->  {"actual":false,"expected":true}
  · 22 报告写明 no-api
  · 23 先打开成功  ->  {"actual":0,"expected":1}
  · 23 报告写明是 self-opened 守卫否决的
  · 23 并由 self-opened 退出监听
```

七类覆盖与实际断言名（正跑那 97 条里的对应项）：

| # | 场景 | 断言 |
|---|---|---|
| ① | 有子代理存活 + 无历史后台任务 + 页关闭 + 无用户输入 | `13 打开一次` / `13 打开的是任务管理页` / `13 不传任何 placement` / `13 不额外调用任何焦点 API` / `13 decisions 里有一条 open-tasks-page` / 七项守卫分量 |
| ② | 同上但用户刚有输入 | `14 用户刚有输入：不开` / `14 报告写明是 user-typed 否决` |
| ③ | 同上但页已开着 | `15 页已经开着：不开` / `15 页已开着 → 退出监听，不空转` |
| ④ | 本轮已开过一次、用户又把它关了 | `16 用户关掉后本轮不再打开（防骚扰优先）` / `16 报告写明「本轮不再打开」` |
| ⑤ | 本会话已有后台任务 | `17 本会话产生过后台任务：不开` / `17 报告写明是 had-jobs 否决` |
| ⑥ | 判定数据缺失 / 结构不认识 | `18a 结构不认识：不开` / `18b 数据整体不可读：不开（fail-closed）` / `18c` 会话行兜底仍能判定 |
| ⑦ | 回归：现有「全停后自动关闭」用例 | `3`（关一次且只一次）/ `10`（关不掉→收栏且不循环）/ `11`（新一轮先关后停）/ `4`/`5`/`6`/`7`/`8`（反向四条）全部照旧通过 |

另有五条约束用例：`19`（插件自己打开的页，子代理跑完**绝不自我关闭**）、`20`（打开造成的跳变**不冒充**「面板自动打开」，
且基线在打开那一刻就推到位，用户随后关掉它不会跨拍丢失）、`21`（打开抛错只上报）、`22`（缺能力只上报）、
`23`（自己打开的页一直开着 → 下一轮带后台任务结束时 `self-opened` 守卫挡在关闭路径前面）。

**反向控制的有效性判据**：把第 3 版的打开动作整体删掉后，**97 条里有 34 条变红**（含 `13`/`16`/`19`/`20`/`21`/`22`/`23` 的全部关键断言）。
若哪天这个数字掉下来，说明新用例被削弱了。

### 第 3 版实机核对步骤（装完 + 重启后，待跑）

1. **反向准备**：确认本轮**不要**起任何会转后台的命令（那会走后台任务触发器，与本行为互斥）；
2. 发一条会让**子代理**跑起来的消息（例如部署一个后台子 agent 做一件事），并在它跑的时候让主代理先把回复收掉；
   —— 期望：报告里出现 `open tasks page via sidebarRight.openTab("subagent") → tab=…`，
   `lastOpenDecision.opened === true`、七项 `guards` 全真；任务管理页自己冒出来并显示还有子代理在跑；
3. **边沿**：把它关掉 → 之后**不应**再自动打开（报告里 `open watch: tasks page closed after our open → 本轮不再打开`）；
4. **不抢焦点**：打开时 `lastOpenDecision.focusBefore` / `focusAfter` 记下前后活动页；插件**不调用**任何焦点 API
   （`caps.focus` 只是探测），也不关任何页；
5. **不打架**：子代理跑完 → 报告里 `subagent watch: 存活子代理已清空 → disarm` / `disarm: subagent-settled`，
   且**没有** `closed tasks page` 行（那一页是我开的，不是面板开的）；
6. **fail-closed**：若报告里出现 `open skipped (…subagent-unknown)` 或 `判定数据缺失/结构不认识 → 不监听`，
   说明本机的形状与 §3 记的不一致 —— 请把 `report.json` 的 `shapes` 段贴回来。

### 实机决策时间线（2026-09-29，`report.json` 9011 B）

一条 `Start-Sleep 60`（`timeoutMs: 5000` → 提升为后台任务 `pwsh-1`）走完全程：

```
new job id(s): pwsh-1                                    ← 提升后的任务被推送镜像看见
tasks page became active (no user input)                 ← 面板 detectNewJob 自动打开并激活任务页
session session-7c3c612a… running: true → false          ← 回合结束（agent 回到空闲）
armed for session-7c3c612a… with 1 live job(s): pwsh-1   ← arm，开始盯
closed tasks page: tab=tab2                              ← 任务自然结束 → 收掉该页
tasks page left (no user input)                          ← 复核：active() 已不再是它
session … running: false → true                          ← 完成通知唤醒新一轮
all settled but tasks page not active → 不动              ← 先判关闭（已没事可做）
disarm: no-page                                          ← 再停表
```

`lastDecision` 三个分量全真，且签名窗口只有 **15 ms**：

```json
{ "autoOpened": true, "allowed": true, "freshJob": true, "noUser": true,
  "signalAgeMs": 55557, "newJobAt": 1790674526581,
  "signal": { "at": 1790674526596, "byUser": false },
  "page": { "tabId": "tab2", "kind": "subagent", "title": "任务管理", "expanded": true } }
```

`freshJob` 由 `|sig.at − newJobAt| = 15 ms` 判定 —— 这正是「不把 `newJobAt` 固化进信号、改在求值时现算」
那处修复的价值：同一个推送里先激活页、后登记新任务 id，固化就会读成过期值而永远判不出自动打开。


### 实机反向时间线（2026-09-29，`report.json` 10108 B）

场景：**作者自己点开**了「任务管理」页，随后跑一条 `Start-Sleep 15`（`timeoutMs: 5000` → 提升为 `pwsh-2`）。预期：**不许关**。实际：

```
tasks page became active (user)                              ← 作者点击，记到 byUser: true
new job id(s): pwsh-2                                        ← 15 s 任务被提升
session … running: true → false                              ← 回合结束
armed for … with 1 live job(s): pwsh-2                       ← arm
settled, but page not provably auto-opened (user touched it) → 不关   ← 正确否决
disarm: not-auto
```

`lastDecision` 里**两条独立判据各自都否决了关闭**：

```json
{ "autoOpened": false, "allowed": true,
  "noUser": false,        // ← 激活跳变时 byUser=true（作者点击）
  "freshJob": false,      // ← 信号时刻与任务出现的间隔 71 s，远超 2.5 s 窗口
  "signalAgeMs": 81631,
  "signal": { "at": 1790674647220, "byUser": true },
  "page": { "tabId": "tab4", "kind": "subagent", "title": "任务管理", "expanded": true } }
```

要点：

- **两条判据互为冗余**：即使 `byUser` 那条失效，`freshJob` 仍会否决；反之亦然。
- `signalAgeMs: 81631` → 信号放了 81 秒仍被采信（判定看的是**事件属性**，不是时效）；真正绑定时间的是 `freshJob` 那条**相对间隔**。
- 那次 arm 里**没有** `closed tasks page` 行 → 作者的页面确实没被动过；且此时页是 `tab4`（作者新开的实例），先前自动打开的那个 `tab2` 已在上一轮被正常收掉。

### 已知小瑕疵（不影响功能）

`decisions` 首批会出现每个会话一条 `running: undefined → false`（首次观察的基线行，本次 37 条）。
它们**不会**触发 arm（arm 要求 `prevBusy === true`），只是让日志偏长。清掉只需在会话循环里加一个
`prevBusy !== undefined` 守卫，但那是纯日志修饰，不值得为它单独占用一次重启。

## 安装（同其它本地插件）

① `<home>/profiles/<profile>/node_modules/` 建符号链接指向本目录；② 该 profile 的 `cordis.patch.yml` 加 `- insert: [{ id: jobs-autoclose, name: dsh-jobs-autoclose }]`；③ **重启实例**。
