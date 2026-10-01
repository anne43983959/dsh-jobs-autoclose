/**
 * dsh-jobs-autoclose · 客户端半（决策全在这里）
 *
 * 需求口径（作者定义）：**一轮**结束（agent 回到 idle）后盯本条会话的后台任务与子代理，
 * 全部停下且「任务管理」页**可证明是自动打开的**→ 收掉它；用户碰过 / 进入新一轮 → 停表。
 *
 * 装载契约：`id` 必须是**包名**（`dsh-jobs-autoclose`）——client-modules 按 bundle 路径推出
 * 期望 id，对不上就整棵插件树装载失败（实测："loaded without registering
 * \"dsh-jobs-autoclose\" via __ModuleLoader__.load"）。对照：dsh-sandbox-sweep/lib/client.js:17。
 *
 * ── 运行时契约（第 2 版按**实测源码**重写；第 1 版三处都猜错了，见 §"第 1 版为什么从不动作"）──
 *
 * ① 「任务管理」页**不在** betterSidebar 自己的面板树里。
 *    `activateTasksPage`（dsh-better-sidebar client.js:15546-15554）走的是
 *    `betterSidebar.openTab({ type: "subagent" })`，而 `openTab` 在
 *    `surface !== undefined && seed.target !== "bottom"` 时**转交原生右栏**
 *    （:1376；surface 恒被 setSurface，:18756）。所以该页是 **DSH 原生右栏的 native tab**，
 *    kind = descriptor id = `"subagent"`（由 `:17034` `tabs.register({ kind: descriptor.id })`
 *    与两处自动打开守卫 `:15723`/`:15759` 的 `isTabEnabled("subagent")` 交叉确认）。
 * ② 原生右栏的服务是 **`ctx.sidebarRight`**（`@deepseek-ai/dsh-client-ui-sidebar-right`，
 *    类型见其 `lib/types/client/service.d.ts`）：
 *      `active(): TabRecord | undefined`  ← 活动 pane 的活动 tab（`{ id, kind, title, … }`）
 *      `isExpanded(): boolean`            ← 栏是展开还是收成轨道
 *      `close(tabId)` / `closeIn(sessionId, tabId)`  ← 关一个 tab（**保留唯一 docked guide**）
 *      `toggleExpanded()`
 *    ⚠️ 别用 `betterSidebar.closeTab`：它的签名是 `(tabId, scope?)`（:1470），
 *    不是 `(paneId, tabId)`；且它先走 native surface 的 `records` 表，只认**它自己**注册的 tab。
 * ③ `betterSidebar.getSnapshot()` = `{ sessionId, state, prefs }`（:919-923 / :933-935）：
 *      · `state.bottomSplits` / `state.bottomOpen` = 插件**自己的底部工作台**，不含任务管理页；
 *      · `prefs` 里才有自动打开开关（`autoOpenJobs` / `autoOpenSubagent`，默认 true，:44-45）。
 * ④ 快照里**根本没有任何时间戳字段**（`openedAt`/`activatedAt`/`createdAt` 全无命中）——
 *    所以「用自动打开的时间签名当所有权代理」在结构上不可能成立。
 *
 * ── 所有权证明（第 2 版：无需时间戳，可证伪）──
 *    面板自动开这一页时**会激活它**（`openTab` 的 reveal 语义；`sidebarRight.openTab` 文档：
 *    "reveal the column"）。于是监听到「活动页**变成了** subagent」这一**跳变**时，看两件事：
 *      · 跳变前 `USER_TOUCH_MS` 内**有没有用户输入**（捕获期 pointer/key/touch/wheel 监听）；
 *      · 同一窗口内**有没有新任务 id 出现**（面板的 job 触发器条件）。
 *    两条都满足，且 `prefs.autoOpenJobs !== false`、`isTabEnabled("subagent") !== false`
 *    （与面板自己的守卫 :15758-15759 逐条对齐）→ 才认定「是面板开的」。任何一条不成立 → 只上报。
 *
 * ── 第 3 版新增：**替子代理把页打开**（用户需求）──
 * 缺口：面板只有两条自动打开触发器 —— `detectNewJob`（后台任务，dsh-better-sidebar
 * :11140-11143 + :15752-15766）与 `detectNewDirectSubagent`（子代理 0→N，:11123-11125）。
 * 当活着的只有**子代理**、且本轮没产生过后台任务时，那一页不会自己出现，用户看不到还有东西在跑。
 * 本插件在这条缝隙里补一次「打开」，条件与面板自己的守卫逐条对齐：
 *   轮结束（会话行 running true→false）+ 无 live 后台任务 + 有 live 子代理
 *   + 本会话从未产生过后台任务 + 页当前是关的 + 打开前 USER_TOUCH_MS 内无用户输入
 *   + `prefs.autoOpenJobs !== false` + `isTabEnabled("subagent") !== false`
 *   + 该会话就是当前会话（openTab 作用于 mounted seat，service.d.ts:1226 的 require()）
 * —— 全部成立才 `ctx.sidebarRight.openTab("subagent")`；缺任何一条只上报（fail-closed）。
 * **边沿触发**：每次「主代理完成一轮回复」的跃迁最多尝试一次；用户随后把它关掉，本轮不再开。
 *
 * 打开用的**唯一真实路径**是 `ctx.sidebarRight.openTab(kind, options)`（公开面 service.d.ts:125，
 * 实现 :1231-1234 → placeTab :1276-1285 → place :1287-1301）。本机契约下它必然展开右栏
 * （store openContent :501 的 `planSetExpanded(state, true)`）并让该页成为活动页；面板自己的
 * 注释把这件事写死了：「The host expands on every open (`openContent` plans
 * `setExpanded(true)`) and offers no option to suppress it」（dsh-better-sidebar :15533-15535）。
 * 所以本插件**不额外**调用任何焦点 API、不传 replaceTab/paneId、不关闭 / 不替换任何已有页。
 *
 * 设计纪律：
 *   · **一切能力先探测再使用**，缺一项就降级为「只报告、不动作」（fail-soft）；
 *   · **把握不足时不关**（fail-closed 到「不动 UI」）——宁可漏关，绝不误关用户自己开的页；
 *   · 全文件 try/catch 包裹，绝不让异常冒出到客户端上下文（会整块空掉）。
 */
window.__ModuleLoader__.load({
	id: "dsh-jobs-autoclose",
	factory: () => {
		const INJECT = ["sessions", "betterSidebar"];
		const BASE_POLL_MS = 2000;          // 与面板既有节律一致（JOB_POLL_MS=2e3 / POLL_MS=2e3）
		const BACKOFF_TICKS = [[3, 5000], [10, 15000]];
		const MAX_POLL_MS = 30000;          // 对齐 WORKTREE_RECHECK_TICKS=15 ≈ 30 s
		const AUTO_OPEN_WINDOW_MS = 2500;   // 「新任务 id 出现」→「页面被激活」的允许间隔
		const USER_TOUCH_MS = 1200;         // 激活前这么久内有过用户输入 → 认定是用户点的
		const TASKS_KIND = "subagent";      // 任务管理页的 native tab kind
		const REPORT_ROUTE = "/api/jobs-autoclose/report";

		function apply(ctx) {
			const log = [];
			/* `event` 是第 3 版加的（约束 5：新行为要进 decisions 时间线）。**不传时对象形状与旧版逐字一致**
			   （`{ at, message }`），所以既有断言与既有实机时间线的读法都不受影响。 */
			const note = (message, event) => {
				log.push(event === undefined ? { at: Date.now(), message } : { at: Date.now(), event, message });
				if (log.length > 80) log.shift();
			};
			const report = { plugin: "jobs-autoclose", version: "0.3.0", mounted: false, caps: {}, shapes: {}, decisions: log };

			try {
				const sessions = ctx.get("sessions");
				const sidebar = ctx.get("betterSidebar");
				const right = ctx.get("sidebarRight");
				report.caps = {
					sessions: sessions !== undefined,
					list: sessions !== undefined && sessions.list !== undefined,
					listSnapshot: sessions !== undefined && sessions.list !== undefined && typeof sessions.list.getSnapshot === "function",
					listSubscribe: sessions !== undefined && sessions.list !== undefined && typeof sessions.list.subscribe === "function",
					sidebar: sidebar !== undefined,
					snapshot: sidebar !== undefined && typeof sidebar.getSnapshot === "function",
					isTabEnabled: sidebar !== undefined && typeof sidebar.isTabEnabled === "function",
					closeTab: sidebar !== undefined && typeof sidebar.closeTab === "function",
					/* 真正的开关：原生右栏 */
					sidebarRight: right !== undefined,
					active: right !== undefined && typeof right.active === "function",
					isExpanded: right !== undefined && typeof right.isExpanded === "function",
					close: right !== undefined && typeof right.close === "function",
					closeIn: right !== undefined && typeof right.closeIn === "function",
					toggleExpanded: right !== undefined && typeof right.toggleExpanded === "function",
					/* 第 3 版新增行为的两个能力位：打开走 openTab，焦点读取走 active（已在上面）。 */
					openTab: right !== undefined && typeof right.openTab === "function",
					focus: right !== undefined && typeof right.focus === "function",
				};
				report.shapes = probeShapes(sessions, sidebar, right);
				report.mounted = report.caps.listSnapshot && report.caps.snapshot;
				note("caps probed");

				/* 每次状态跃迁都推一份报告 —— 否则只有 mount 与「关成功」才落盘，
				   实机测一次「什么都没发生」就完全没有证据可查（上一轮就吃了这个亏）。 */
				const post = () => { postReport(REPORT_ROUTE, report); };
				const watch = createWatcher(ctx, { sessions, sidebar, right, report, note, post });
				ctx.effect(() => watch.stop, "jobs-autoclose: watcher teardown");
				watch.start();
				post();
			} catch (error) {
				report.error = String(error);
				try { postReport(REPORT_ROUTE, report); } catch { /* 报告失败不再冒泡 */ }
			}
		}

		/** 探测真实形状，供开发者核对（第 2 版的收口依据就是这些字段）。 */
		function probeShapes(sessions, sidebar, right) {
			const shapes = {};
			try {
				const snap = sidebar.getSnapshot();
				shapes.snapshotTopKeys = snap === null || snap === undefined ? null : Object.keys(snap);
				shapes.prefsKeys = snap && snap.prefs !== undefined && snap.prefs !== null ? Object.keys(snap.prefs) : null;
				shapes.stateKeys = snap && snap.state !== undefined && snap.state !== null ? Object.keys(snap.state) : null;
				shapes.autoOpenJobs = snap && snap.prefs !== undefined ? snap.prefs.autoOpenJobs : undefined;
			} catch { shapes.snapshotTopKeys = "throw"; }
			try {
				shapes.tasksTabEnabled = sidebar.isTabEnabled === undefined ? undefined : sidebar.isTabEnabled(TASKS_KIND);
			} catch { shapes.tasksTabEnabled = "throw"; }
			try {
				const s = sessions.list.getSnapshot();
				shapes.listTopKeys = s === null || s === undefined ? null : Object.keys(s);
				const row = sessionRows(sessions)[0];
				shapes.sessionRowKeys = row === undefined ? null : Object.keys(row);
				shapes.sessionRunning = row === undefined ? null : row.running;
				shapes.sessionIds = sessionRows(sessions).map((r) => sessionIdOf(r));
				shapes.byIdCount = s && s.byId !== undefined && s.byId !== null ? (typeof s.byId.get === "function" ? s.byId.size : Object.keys(s.byId).length) : null;
				shapes.idsCount = s && Array.isArray(s.ids) ? s.ids.length : null;
			} catch { shapes.sessionRowKeys = "throw"; }
			try {
				const bySession = jobMap(sessions);
				for (const rows of Object.values(bySession)) {
					if (Array.isArray(rows) && rows.length > 0) { shapes.jobRowKeys = Object.keys(rows[0]); break; }
				}
			} catch { shapes.jobRowKeys = "throw"; }
			try {
				const rec = right === undefined ? undefined : right.active();
				shapes.activeTab = rec === undefined || rec === null ? null : { keys: Object.keys(rec), kind: rec.kind, id: rec.id, title: rec.title };
				shapes.isExpanded = right === undefined ? undefined : right.isExpanded();
			} catch (error) { shapes.activeTab = "throw: " + String(error); }
			/* 子代理形状（第 3 版「打开」行为的判定依据）——把 catalog 形与会话行判据都报出来，
			   实机核对时一眼能看出插件读的是哪一套、结构认不认识。 */
			try {
				const s = sessions.list.getSnapshot();
				shapes.currentSessionId = s === null || s === undefined ? null : (s.current ?? null);
				const map = s === null || s === undefined ? undefined : s.subagentsByParent;
				shapes.subagentsTopKeys = map === null || map === undefined ? null : Object.keys(map);
				const catalog = map === null || map === undefined || shapes.currentSessionId === null ? undefined : map[shapes.currentSessionId];
				shapes.catalogKeys = catalog === null || catalog === undefined ? null : Object.keys(catalog);
				shapes.catalogState = catalog === null || catalog === undefined ? null : catalog.state;
				const entries = catalog === null || catalog === undefined || !Array.isArray(catalog.entries) ? null : catalog.entries;
				shapes.catalogEntryKeys = entries !== null && entries.length > 0 ? Object.keys(entries[0]) : null;
				shapes.catalogEntryCount = entries === null ? null : entries.length;
				const live = liveSubagents(sessions, shapes.currentSessionId);
				shapes.liveSubagents = { known: live.known, source: live.source, count: live.count, ids: live.ids };
			} catch (error) { shapes.subagentsTopKeys = "throw: " + String(error); }
			return shapes;
		}

		/** jobsBySession：会话列表快照里的推送镜像（面板同样用它，client.js:15721 / :12004）。 */
		function jobMap(sessions) {
			const s = sessions.list.getSnapshot();
			return (s && s.jobsBySession) ? s.jobsBySession : {};
		}
		/**
		 * 会话行读取。⚠️ 真形状 —— 两个字面来源都已核对，且**实机自检亲口报出**：
		 *   · 实机 `shapes.listTopKeys` = `["ids","byId","current","phase","subagentsByParent","jobsBySession","currentAddress"]`
		 *   · 源码 `@deepseek-ai/dsh-api-session-controller/lib/client.js:3416-3424` 的 `this.list.set({…})`
		 * 即：**行在 `byId`（按 sessionId 索引的普通对象），顺序在 `ids`**；**没有 `items` / `sessions` 键**。
		 * 行形（:3367-3379）：`{ id, displayTitle, running:boolean, blank, updatedAt, completed?, title?, cwd?, parentId?, origin? }`
		 * —— 会话 id 字段是 **`id`**，「忙」是 **`running` 布尔**。
		 *
		 * 踩过的坑（同一天两次，都是「离线全绿、实机静默」）：先写成 `s.sessions`，再写成 `s.items`
		 * —— 后者是 `manager.getListSnapshot()`（:3362）的形状，**不是** `ctx.sessions.list.getSnapshot()` 的形状。
		 * 同一个包里两套投影，读错哪一套都是空数组、都不抛异常。
		 */
		function sessionRows(sessions) {
			const s = sessions.list.getSnapshot();
			if (s === null || s === undefined) return [];
			/* 兜底：万一本机换成 manager 那套投影（`items`），也别再读成空数组。 */
			if (s.byId === null || s.byId === undefined) return Array.isArray(s.items) ? s.items.filter((row) => row !== null && row !== undefined) : [];
			const byId = s.byId;
			/* byId 可能是普通对象（源码用字面量构造）也可能被换成 Map —— 两种都吃。 */
			const lookup = (id) => (typeof byId.get === "function" ? byId.get(id) : byId[id]);
			const rows = [];
			if (Array.isArray(s.ids)) {
				for (const id of s.ids) { const row = lookup(id); if (row !== null && row !== undefined) rows.push(row); }
			}
			if (rows.length === 0) {
				const values = typeof byId.get === "function" ? Array.from(byId.values()) : Object.values(byId);
				for (const row of values) if (row !== null && row !== undefined) rows.push(row);
			}
			return rows;
		}
		function sessionIdOf(row) { return row && (row.id ?? row.sessionId); }
		/** 「忙」= `running === true`（缺字段视为不忙，与列表投影一致）。 */
		function busyOf(row) { return row !== null && row !== undefined && row.running === true; }

		/** 会话列表快照的唯一入口（形状见 sessionRows 的注释；读不到一律返回 null，由调用方 fail-closed）。 */
		function sessionSnapshot(sessions) {
			try { return sessions.list.getSnapshot(); } catch { return null; }
		}
		/**
		 * 当前选中会话 —— 顶层键 `current`（源码 `@deepseek-ai/dsh-api-session-controller/lib/client.js:3419`
		 * 的 `this.list.set({ ids, byId, current, … })`；实机自检 `shapes.listTopKeys` 也亲口报出它）。
		 * 为什么要它：`sidebarRight.openTab` 只作用于 **mounted seat 的会话**
		 * （`service.d.ts:1226` 的 `this.require()`），拿别的会话去开会张冠李戴，所以只对当前会话动手。
		 */
		function currentSessionId(sessions) {
			const s = sessionSnapshot(sessions);
			if (s === null || s === undefined) return null;
			const cur = s.current;
			return typeof cur === "string" && cur !== "" ? cur : null;
		}
		/**
		 * 子代理目录 —— 快照顶层 `subagentsByParent`（源码 :2918 `Object.fromEntries(this.catalogs)`）。
		 * **读不到结构返回 null**（而不是 `{}`）：空对象会被下游读成「这个会话确实没有子代理」，
		 * 那是**误判**；fail-closed 要求「结构不认识」与「确实没有」必须可区分。
		 */
		function subagentMap(sessions) {
			const s = sessionSnapshot(sessions);
			if (s === null || s === undefined) return null;
			const map = s.subagentsByParent;
			if (map === null || map === undefined || typeof map !== "object") return null;
			return map;
		}
		/**
		 * 「这个子代理还活着吗」—— 与面板的 `isJobLive`（dsh-better-sidebar :11129-11131
		 * `status === "running" || status === "stopping"`）**同口径**；本机实测的 activity 取值域是
		 * `{"running","inactive"}`（源码 :2809 `const activity = running ? "running" : "inactive"`，
		 * 并据 :3396 `running: child.activity === "running"` 供会话行使用）。`"stopping"` 留着不删：
		 * 它与 isJobLive 逐字对齐，将来若驱动侧补上这个态，不需要再改判定。
		 */
		function liveActivity(value) { return value === "running" || value === "stopping"; }
		/**
		 * 读取「某会话存活的子代理」。**两条来源都来自实测源码**，互为冗余：
		 *   ① catalog：`subagentsByParent[sessionId]` 形在 :2416-2434
		 *      （`{ entries, parentAvailable?, state: "loading"|"ready"|"error", error }`），
		 *      行形在 :2856-2864（`{ kind:"child", id, label?, hasChildren?, activity? }`）；
		 *      `state === "error"` 时 entries 可能是上一次的旧值 → **按不可读处理**（fail-closed）。
		 *   ② 会话行：`origin === "subagent"` + `parentId === sessionId` + `running === true`
		 *      （dsh-better-sidebar :11092-11097 `directSubagentCount` 与 :11062 的 `running === true`）。
		 * 返回 `{ known, source, count, ids }`：`known === false` 表示**判定数据缺失/结构不认识**
		 * —— 调用方必须据此否决打开（不允许把「不知道」当成「没有」）。
		 */
		function liveSubagents(sessions, sessionId) {
			const out = { known: false, source: null, count: 0, ids: [] };
			if (typeof sessionId !== "string" || sessionId === "") return out;
			let catalogReadable = false;
			try {
				const map = subagentMap(sessions);
				if (map !== null) {
					const catalog = map[sessionId];
					if (catalog === undefined) catalogReadable = true;   /* 目录里没有这个父会话 → 明确「无子代理」 */
					else if (catalog !== null && typeof catalog === "object" && Array.isArray(catalog.entries) && catalog.state !== "error") {
						catalogReadable = true;
						for (const entry of catalog.entries) {
							if (entry === null || entry === undefined || entry.kind !== "child") continue;
							if (!liveActivity(entry.activity)) continue;
							out.ids.push(String(entry.id));
						}
					}
				}
			} catch { catalogReadable = false; }
			let rowsReadable = false;
			const rowIds = [];
			try {
				const s = sessionSnapshot(sessions);
				if (s !== null && s.byId !== null && s.byId !== undefined) {
					rowsReadable = true;
					for (const row of sessionRows(sessions)) {
						if (row === null || row === undefined) continue;
						if (row.origin !== "subagent" || row.parentId !== sessionId || row.running !== true) continue;
						const id = sessionIdOf(row);
						if (id !== undefined) rowIds.push(String(id));
					}
				}
			} catch { rowsReadable = false; }
			out.known = catalogReadable || rowsReadable;
			out.source = catalogReadable && rowsReadable ? "catalog+rows" : catalogReadable ? "catalog" : rowsReadable ? "rows" : null;
			for (const id of rowIds) if (!out.ids.includes(id)) out.ids.push(id);
			if (!out.known) return { known: false, source: null, count: 0, ids: [] };
			out.count = out.ids.length;
			return out;
		}

		/**
		 * 任务是否还活着——**逐字对齐面板自己的判据**（dsh-better-sidebar client.js:11129-11131
		 * `isJobLive`：`status === "running" || status === "stopping"`）。
		 * 例外：`status` 完全缺失时保守视为**活着**（宁可漏关，不在状态不明时动手）。
		 */
		function isLive(job) {
			const status = job === null || job === undefined ? undefined : job.status;
			if (typeof status !== "string") return true;
			return status === "running" || status === "stopping";
		}

		function createWatcher(ctx, deps) {
			const { sessions, sidebar, right, report, note } = deps;
			const state = {
				armed: null,             // { sessionId, since, mode: "close"|"open", openState }
				timer: null,
				interval: BASE_POLL_MS,
				idleTicks: 0,
				prevBusy: new Map(),
				lastNewJobAt: new Map(),
				lastJobIds: new Map(),
				/* 第 3 版前提：本插件**观察到过**该会话的后台任务。必须粘住 —— 任务结束就从
				   jobsBySession 里删掉了（源码 :2677-2678），只看当前快照会说「从没产生过」。 */
				everHadJobs: new Set(),
				userTouchAt: 0,
				seen: false,
				prevTasksActive: false,
				tasksSignal: null,       // { at, byUser, newJobAt }
				closeTried: null,        // { tabId, at, collapsed }
				selfOpened: null,        // { sessionId, at, tabId } —— 本插件自己打开的那一页（禁止被自己关掉）
				lastOpenDecision: null,  // 第 3 版：打开判定的完整分量（进报告）
			};
			/* 第 3 版：报告里始终带上打开判定的分量 —— 在这里包一层，既有 post() 调用点一个都不用改。 */
			const post = () => { report.lastOpenDecision = state.lastOpenDecision; return deps.post(); };

			function readJobs(sessionId) {
				const rows = jobMap(sessions)[sessionId];
				return Array.isArray(rows) ? rows : [];
			}

			/** 捕获期监听用户输入：这是「用户碰过」唯一的硬证据（快照里没有这类字段）。 */
			function attachInputProbe() {
				const mark = () => { state.userTouchAt = Date.now(); };
				const types = ["pointerdown", "mousedown", "keydown", "touchstart", "wheel", "click"];
				for (const type of types) { try { window.addEventListener(type, mark, true); } catch { /* 个别事件名在旧环境可能不支持 */ } }
				return () => { for (const type of types) { try { window.removeEventListener(type, mark, true); } catch { /* 同上 */ } } };
			}

			/** 事件驱动优先：有 subscribe 就订阅，否则退化为基线轮询。 */
			function start() {
				let subscribed = false;
				try {
					if (typeof sessions.list.subscribe === "function") {
						sessions.list.subscribe(() => onTick());
						subscribed = true;
						report.caps.subscribed = true;
					}
				} catch (error) { note("subscribe failed: " + String(error)); }
				if (!subscribed) { schedule(); report.caps.subscribed = false; }
			}

			function schedule() {
				if (state.timer !== null) return;
				state.timer = window.setTimeout(() => { state.timer = null; onTick(); schedule(); }, state.interval);
			}
			function backoff(changed) {
				if (changed) { state.idleTicks = 0; state.interval = BASE_POLL_MS; return; }
				state.idleTicks += 1;
				for (const [ticks, ms] of BACKOFF_TICKS) if (state.idleTicks >= ticks) state.interval = ms;
				if (state.interval > MAX_POLL_MS) state.interval = MAX_POLL_MS;
			}

			/** 任务管理页此刻是不是**活动页**；是则返回它的 tab 标识。 */
			function tasksPage() {
				try {
					if (right === undefined || typeof right.active !== "function") return null;
					const rec = right.active();
					if (rec === undefined || rec === null) return null;
					if (String(rec.kind ?? "") !== TASKS_KIND) return null;
					const tabId = rec.id ?? rec.tabId;
					if (tabId === undefined || tabId === null) return null;
					let expanded = false;
					try { expanded = right.isExpanded() === true; } catch { expanded = false; }
					return { tabId, kind: TASKS_KIND, title: rec.title, expanded };
				} catch (error) { note("tasksPage failed: " + String(error)); return null; }
			}

			/** 每次数据变化/定时节拍都走这里：先判「该关了吗」，再判「是否新一轮」。 */
			function onTick() {
				try {
					let changed = false;
					/* ① 记录「任务管理页」的活动跳变 —— 自动打开会激活它，这是所有权证明的一半。 */
					const page = tasksPage();
					const activeNow = page !== null;
					/* 首次观察只取基线，**不**算激活跳变 —— 与面板自己的纪律一致
					   （dsh-better-sidebar :15749-15750「A fresh page load never triggers —
					   its baseline starts at the current snapshot」）。否则「装载前就开着的页」
					   会在第一拍被误判成自动打开，一旦这一拍恰好有新任务就是一次误关。 */
					if (!state.seen) { state.seen = true; state.prevTasksActive = activeNow; }
					else if (activeNow !== state.prevTasksActive) {
						/* ⚠️ 这里**不能**固化 `newJobAt`：本轮 tick 的任务扫描还在后面（顺序见 ②），
						   固化会把「同一个推送里先激活页、后登记新任务 id」读成过期值 → 永远判不出自动打开。
						   所以只记「激活时刻 + 有无用户输入」，新任务时刻在求值时现算。 */
						state.tasksSignal = {
							at: Date.now(),
							byUser: state.userTouchAt > 0 && (Date.now() - state.userTouchAt) <= USER_TOUCH_MS,
							becameActive: activeNow,
						};
						changed = true;
						/* 第 3 版：**本插件自己打开**的那一页造成的激活跳变不算「面板自动打开」的证据 ——
						   打上 bySelf，关闭路径据此否决，避免「关闭判定被打开动作污染」。 */
						if (activeNow && state.selfOpened !== null) state.tasksSignal.bySelf = true;
						note((activeNow ? "tasks page became active" : "tasks page left") + (state.tasksSignal.byUser ? " (user)" : " (no user input)") + (state.tasksSignal.bySelf === true ? " (opened by this plugin)" : ""));
						/* 页离开了 = 我们打开的那一页已经不在了：所有权标记就此失效（下次谁开的就是谁开的）。 */
						if (!activeNow && state.selfOpened !== null) state.selfOpened = null;
						/* 边沿纪律：我们自己打开的页又被关掉 → 本轮不再打开（防骚扰优先于「一定要让用户看见」）。 */
						if (!activeNow && state.armed !== null && state.armed.mode === "open" && state.armed.openState === "opened") {
							state.armed.openState = "user-closed";
							note("open watch: tasks page closed after our open → 本轮不再打开", "open-tasks-page-skipped");
						}
						post();
					}
					state.prevTasksActive = activeNow;

					/* ② 会话行：`running` 布尔跳变 —— 忙→闲 = 轮结束（arm），闲→忙 = 新一轮。
					   （判据出处见 sessionRows 的注释：真字段是 `running`，不是 `status` 字符串。） */
					for (const row of sessionRows(sessions)) {
						const id = sessionIdOf(row);
						if (id === undefined) continue;
						const busy = busyOf(row);
						const prevBusy = state.prevBusy.get(id);
						state.prevBusy.set(id, busy);
						if (busy !== prevBusy) { changed = true; note("session " + id + " running: " + String(prevBusy) + " → " + String(busy)); }

						const ids = readJobs(id).map((j) => j && j.id);
						const known = state.lastJobIds.get(id) ?? new Set();
						const fresh = ids.filter((x) => x !== undefined && !known.has(x));
						if (fresh.length > 0) { state.lastNewJobAt.set(id, Date.now()); changed = true; note("new job id(s): " + fresh.join(",")); }
						state.lastJobIds.set(id, new Set(ids));
						/* 「本会话产生过后台任务」是**粘性**事实（任务结束后镜像里就没了，源码 :2677-2678）。 */
						if (ids.length > 0 && !state.everHadJobs.has(id)) { state.everHadJobs.add(id); changed = true; }

						/* 新一轮（用户发消息，或完成通知自己唤醒）：**先判关闭再停监听**，
						   否则最后一次结算会被这次唤醒抢掉，面板永远等不到关闭。 */
						if (prevBusy === false && busy === true && state.armed !== null && state.armed.sessionId === id) {
							evaluate();
							disarm("new-round");
						}
						if (prevBusy === true && busy === false) armIfActive(id);
					}
					if (state.armed !== null) evaluate();
					backoff(changed);
				} catch (error) { note("tick failed: " + String(error)); }
			}

			function newestJobAt() {
				let newest = 0;
				for (const at of state.lastNewJobAt.values()) if (at > newest) newest = at;
				return newest;
			}

			function armIfActive(sessionId) {
				const active = readJobs(sessionId).filter(isLive);
				if (active.length === 0) { armOpenWatch(sessionId); return; }
				/* 「本插件自己开的页」标记**不在这里清**：它的生命周期 = 从我们打开它，到它离开活动位为止
				   （`onTick` ① 在页离开时清）。这样关闭路径上的 `self-opened` 守卫是真生效的，
				   而不是一条摆设 —— 宁可漏关，绝不误关。 */
				state.armed = { sessionId, since: Date.now(), mode: "close", openState: "n/a" };
				state.interval = BASE_POLL_MS; state.idleTicks = 0;
				note("armed for " + sessionId + " with " + active.length + " live job(s): " + active.map((j) => j.id).join(","));
				post();
				evaluate();
			}

			/**
			 * 第 3 版分支：**轮结束、本条会话没有活着的后台任务，但有活着的子代理**。
			 * 这正是需求要补的那条缝 —— 面板的两条自动打开触发器（后台任务 :11140-11143 /
			 * 子代理 0→N :11123-11125）都不响的时候，用户看不到还有子代理在跑。
			 * 判定数据缺失 / 结构不认识 → **不 arm**（fail-closed）。
			 */
			function armOpenWatch(sessionId) {
				const subs = liveSubagents(sessions, sessionId);
				if (!subs.known) {
					note("turn end: no live job; 子代理判定数据缺失/结构不认识 → 不监听（fail-closed）", "open-tasks-page-skipped");
					post();
					return;
				}
				if (subs.count === 0) { note("turn end: no live job / no live subagent → 不监听"); post(); return; }
				state.armed = { sessionId, since: Date.now(), mode: "open", openState: "idle" };
				state.interval = BASE_POLL_MS; state.idleTicks = 0;
				note("armed for " + sessionId + " (subagent watch) with " + subs.count + " live subagent(s): " + subs.ids.join(","));
				post();
				/* 边沿触发：这一轮的最多一次打开尝试，就在此刻。 */
				tryOpenTasksPage();
			}

			/** 面板自己的两条守卫（对照 dsh-better-sidebar client.js:15758-15759）。
			 *  第 3 版把两条**拆成分量**返回：打开路径要把「是 prefs 关的还是页被禁用的」写进报告。 */
			function autoOpenVerdict() {
				let prefsAllowed = true;
				try {
					const snap = sidebar.getSnapshot();
					if (snap && snap.prefs && snap.prefs.autoOpenJobs === false) prefsAllowed = false;
				} catch { /* 读不到 prefs 时不据此否决（沿用旧口径） */ }
				let tabEnabled = true;
				try {
					if (sidebar.isTabEnabled !== undefined && sidebar.isTabEnabled(TASKS_KIND) === false) tabEnabled = false;
				} catch { /* 同上 */ }
				return { prefsAllowed, tabEnabled, allowed: prefsAllowed && tabEnabled };
			}
			function autoOpenAllowed() { return autoOpenVerdict().allowed; }

			/** 只读地看一眼当前活动页（**绝不出手改焦点**）——报告里记「打开把哪一页带到前台」。 */
			function readFocus() {
				try {
					if (right === undefined || typeof right.active !== "function") return null;
					const rec = right.active();
					if (rec === undefined || rec === null) return null;
					return { id: rec.id ?? rec.tabId ?? null, kind: rec.kind ?? null, title: rec.title ?? null };
				} catch { return null; }
			}

			/** 守卫向量的单行摘要 —— decisions 与 lastOpenDecision 共用，实机一眼能读。 */
			function guardsLine(guards) {
				return [
					"page=" + (guards.pageClosed ? "closed" : "open"),
					"input=" + (guards.quiet ? "quiet" : "recent"),
					"prefs=" + (guards.prefsAllowed ? "allowed" : "off"),
					"tab=" + (guards.tabEnabled ? "enabled" : "disabled"),
					"session=" + (guards.sameSession ? "current" : "other"),
					"jobs=" + (guards.noPriorJobs ? "none-ever" : "seen"),
					"subagents=" + (guards.liveSubagents ? "live" : "none-or-unknown"),
				].join(", ");
			}

			/**
			 * 第 3 版：把「任务管理」页打开。**唯一真实路径** = `ctx.sidebarRight.openTab("subagent")`
			 * （公开面 service.d.ts:125；实现 :1231-1234 → placeTab :1276-1285 → place :1287-1301）。
			 * 不传 `paneId` / `replaceTab` / `revealIfOpened`：不开新 pane、不替换、不关闭任何已有页。
			 * **不额外调用任何焦点 API** —— 本机契约里 openTab 自带 reveal（store :501 的
			 * `planSetExpanded(state, true)`；面板注释 :15533-15535 也写明「offers no option to suppress it」），
			 * 那是这条路径的固有语义，插件不再叠加任何动作；焦点变化如实记进 lastOpenDecision。
			 *
			 * 守卫链（顺序即判定顺序，任一不成立都只上报、不动 UI；判定不明确同样否决）：
			 *   G0 能力 G1 边沿 G2 页状态 G3 用户输入 G4 开关 G5 会话一致 G6 前提 G7 依据。
			 */
			function tryOpenTasksPage() {
				const armed = state.armed;
				if (armed === null || armed.mode !== "open") return;
				const sessionId = armed.sessionId;
				const subs = liveSubagents(sessions, sessionId);
				const verdict = autoOpenVerdict();
				const quietMs = state.userTouchAt === 0 ? null : (Date.now() - state.userTouchAt);
				const guards = {
					apiOk: right !== undefined && typeof right.openTab === "function",
					edge: armed.openState === "idle",
					pageClosed: tasksPage() === null,
					quiet: quietMs === null || quietMs > USER_TOUCH_MS,
					prefsAllowed: verdict.prefsAllowed,
					tabEnabled: verdict.tabEnabled,
					sameSession: currentSessionId(sessions) === sessionId,
					noPriorJobs: !state.everHadJobs.has(sessionId),
					liveSubagents: subs.known && subs.count > 0,
				};
				const failed = [];
				if (!guards.apiOk) failed.push("no-api");
				if (!guards.edge) failed.push("already-attempted");
				if (!guards.pageClosed) failed.push("page-open");
				if (!guards.quiet) failed.push("user-typed");
				if (!guards.prefsAllowed) failed.push("prefs-off");
				if (!guards.tabEnabled) failed.push("tab-disabled");
				if (!guards.sameSession) failed.push("not-current-session");
				if (!guards.noPriorJobs) failed.push("had-jobs");
				if (!guards.liveSubagents) failed.push(subs.known ? "no-live-subagent" : "subagent-unknown");
				state.lastOpenDecision = {
					opened: false, at: Date.now(), sessionId, guards,
					liveSubagents: { known: subs.known, source: subs.source, count: subs.count, ids: subs.ids },
					everHadJobs: Array.from(state.everHadJobs),
					userQuietMs: quietMs,
					reason: failed.length === 0 ? null : failed.join(","),
				};
				if (failed.length > 0) {
					if (armed.openState === "idle") armed.openState = "skipped:" + failed[0];
					note("open skipped (" + failed.join(" & ") + ") → 不打开任务页 [guards: " + guardsLine(guards) + "]", "open-tasks-page-skipped");
					post();
					/* 「页已经开着」是唯一**无事可做**的否决：用户本来就看得到 → 退出监听，不空转。 */
					if (!guards.pageClosed) disarm("page-open");
					return;
				}
				const before = readFocus();
				try {
					right.openTab(TASKS_KIND);
				} catch (error) {
					armed.openState = "failed:open-throw";
					state.lastOpenDecision = { ...state.lastOpenDecision, reason: "open-throw: " + String(error) };
					note("open tasks page failed (threw): " + String(error), "open-tasks-page-skipped");
					post();
					return;
				}
				const after = readFocus();
				const tabId = after === null ? null : after.id;
				armed.openState = "opened";
				state.selfOpened = { sessionId, at: Date.now(), tabId };
				/* 基线与信号在**打开这一刻**就写好：① 我们知道它现在是活动页；② 这次激活是本插件造成的
				   （`bySelf` → 关闭路径据此否决，绝不冒充「面板自动打开」）；③ 用户随后关掉它的那次
				   跳变才不会被跨拍漏掉（onTick ① 只在活动态变化时才记账）。 */
				state.tasksSignal = { at: Date.now(), byUser: false, becameActive: true, bySelf: true };
				state.prevTasksActive = true;
				state.lastOpenDecision = {
					...state.lastOpenDecision, opened: true, at: Date.now(),
					path: 'sidebarRight.openTab("' + TASKS_KIND + '")',
					focusBefore: before, focusAfter: after, reason: null,
				};
				note('open tasks page via sidebarRight.openTab("' + TASKS_KIND + '")' + (tabId === null ? "" : " → tab=" + tabId) + " — 守卫全过 [guards: " + guardsLine(guards) + "]", "open-tasks-page");
				post();
			}

			/**
			 * open 模式每拍跑一次：**只判「该不该停表」，永不关页**。
			 * （关闭路径与打开路径时间窗互斥：关闭只在「本轮无活跃项」时判，而 open 模式的前提就是有活跃子代理。）
			 */
			function evaluateOpenWatch() {
				const armed = state.armed;
				if (armed === null || armed.mode !== "open") return;
				const subs = liveSubagents(sessions, armed.sessionId);
				if (!subs.known) { note("subagent watch: 判定数据不可读 → disarm（fail-closed）"); disarm("subagent-unknown"); return; }
				if (subs.count === 0) { note("subagent watch: 存活子代理已清空 → disarm"); disarm("subagent-settled"); return; }
				if (state.everHadJobs.has(armed.sessionId)) { note("subagent watch: 本会话出现了后台任务 → disarm（那条场景归后台任务）"); disarm("jobs-appeared"); return; }
				if (armed.openState === "idle") tryOpenTasksPage();
			}

			/**
			 * 关的条件：本轮无活跃项 + 页仍活动 + 可证明是面板自动打开的 + 用户没发起新一轮。
			 * 全部满足才动手；缺任何一条都只上报（fail-closed）。
			 */
			function evaluate() {
				const armed = state.armed;
				if (armed === null) return;
				/* 第 3 版：open 模式的 arm 只做「停表」判断，绝不走关闭路径 —— 时间窗天然互斥。 */
				if (armed.mode === "open") { evaluateOpenWatch(); return; }
				if (readJobs(armed.sessionId).filter(isLive).length > 0) return;

				const page = tasksPage();
				if (page === null) { note("all settled but tasks page not active → 不动"); disarm("no-page"); return; }
				/* 第 3 版守卫（约束 1）：这一页若是**本插件自己打开**的，绝不自我关闭 ——
				   让「刚打开就被自己关掉」在结构上不可能，即便将来 freshJob 判定被别的路径污染。 */
				if (state.selfOpened !== null && state.selfOpened.sessionId === armed.sessionId) {
					note("settled, but this page was opened by the plugin itself → 不关 (self-opened)");
					disarm("self-opened");
					return;
				}

				const sig = state.tasksSignal;
				const signalAgeMs = sig === null ? null : Math.abs(Date.now() - sig.at);
				const newJobAt = newestJobAt();
				const freshJob = newJobAt > 0 && sig !== null && Math.abs(sig.at - newJobAt) <= AUTO_OPEN_WINDOW_MS;
				const noUser = sig !== null && sig.byUser === false;
				const allowed = autoOpenAllowed();
				/* `sig.bySelf` = 这次激活跳变是本插件自己 openTab 造成的 → 它**不是**「面板自动打开」的证据。 */
				const autoOpened = sig !== null && sig.becameActive === true && noUser && freshJob && allowed && sig.bySelf !== true;

				report.lastDecision = {
					autoOpened, page, allowed, freshJob, noUser, signalAgeMs, newJobAt,
					signal: sig === null ? null : { at: sig.at, byUser: sig.byUser, bySelf: sig.bySelf === true },
				};

				if (!autoOpened) {
					const why = sig === null ? "no signal" : !sig.becameActive ? "page not newly activated" : sig.bySelf === true ? "opened by this plugin" : sig.byUser ? "user touched it" : !freshJob ? "no new job in window" : "prefs/tab disabled";
					note("settled, but page not provably auto-opened (" + why + ") → 不关");
					disarm("not-auto");
					return;
				}
				closePage(page);
			}

			/** 收页面：先 `close(tabId)`；若它是唯一 docked 页（原生保留），退一步收栏。 */
			function closePage(page) {
				if (right === undefined) { note("sidebarRight missing → 只报告不动作"); disarm("no-api"); return; }
				const tried = state.closeTried;
				if (tried !== null && tried.tabId === page.tabId) {
					/* 上一拍已经关过同一个 tab 但它还在 → 再退一步：收起整栏。 */
					if (tried.collapsed === false && typeof right.toggleExpanded === "function" && page.expanded) {
						try { right.toggleExpanded(); note("close refused (sole docked tab?) → collapsed column"); } catch (error) { note("toggleExpanded failed: " + String(error)); }
						state.closeTried = { tabId: page.tabId, at: Date.now(), collapsed: true };
						return;
					}
					note("page still active after close+collapse → 放弃，不动 UI");
					disarm("close-refused");
					return;
				}
				if (typeof right.close !== "function") { note("sidebarRight.close missing → 只报告不动作"); disarm("no-api"); return; }
				try {
					right.close(page.tabId);
					note("closed tasks page: tab=" + page.tabId);
					state.closeTried = { tabId: page.tabId, at: Date.now(), collapsed: false };
					post();
				} catch (error) {
					note("close failed: " + String(error));
					disarm("close-failed");
				}
			}

			function disarm(reason) {
				if (state.armed === null) return;
				note("disarm: " + reason);
				if (state.armed.mode === "open" && state.lastOpenDecision !== null) {
					state.lastOpenDecision = { ...state.lastOpenDecision, disarmedAt: Date.now(), disarmReason: reason };
				}
				state.armed = null;
				state.interval = BASE_POLL_MS; state.idleTicks = 0;
				state.closeTried = null;
				post();
			}

			const detachInput = attachInputProbe();
			return { start, onTick, stop() {
				if (state.timer !== null) window.clearTimeout(state.timer);
				state.timer = null; state.armed = null;
				try { detachInput(); } catch { /* teardown 失败不冒泡 */ }
			} };
		}

		async function postReport(url, body) {
			try {
				await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			} catch { /* 报告失败静默 */ }
		}

		return { apply, inject: INJECT };
	},
});
