/**
 * dsh-jobs-autoclose · 客户端半离线冒烟（真源码 + 桩 ctx；不起浏览器）
 *
 * 装载契约按 dsh-plugin-authoring §7：loader 同形装载真源码、断言注册面与决策表。
 * 第 2 版的桩按**实测契约**搭：原生右栏是 `ctx.sidebarRight`（`active()` / `isExpanded()` /
 * `close(tabId)` / `toggleExpanded()`），betterSidebar 快照是 `{ sessionId, state, prefs }`，
 * 任务管理页 kind = `"subagent"`。第 1 版的桩（自己编的 `pageAt(openedAt)` 时间戳形）
 * 正是因为照着自己的想象搭，才让三处错误一路绿灯通过。
 *
 * 期望末行：ALL OK (n assertions)。
 */
import { resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";

let passed = 0; const failures = [];
const ok = (c, label, detail) => { if (c) { passed += 1; return; } failures.push(label + (detail === undefined ? "" : "  ->  " + JSON.stringify(detail))); };
const eq = (a, b, label) => ok(Object.is(a, b), label, { actual: a, expected: b });
const tick = () => new Promise((r) => setTimeout(r, 0));

/* 可控时钟：用例 6 要造一个「激活远晚于新任务出现」的真时间差。
   同步 tick 全在同一毫秒里跑完，不动时钟就造不出窗口外的间隔。 */
const realNow = Date.now.bind(Date);
let clockSkew = 0;
Date.now = () => realNow() + clockSkew;
const advance = (ms) => { clockSkew += ms; };

const posts = [];
const loaders = [];
const listeners = new Map();          // 捕获期用户输入探针挂在这上面
globalThis.window = {
	__ModuleLoader__: { load: (m) => loaders.push(m) },
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
	removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
};
/** 模拟一次真实用户输入（点击/按键）。 */
const userInput = () => { for (const fn of listeners.get("pointerdown") ?? []) fn(); };
globalThis.fetch = async (url, init) => { posts.push({ url, body: JSON.parse((init ?? {}).body ?? "{}") }); return { ok: true }; };

/** 可用 JA_CLIENT_MODULE 指向另一份客户端半实现 —— 用于反向控制（见 fixtures/client-no-open.mjs）。 */
const CLIENT_MODULE = process.env.JA_CLIENT_MODULE ?? pathResolve(import.meta.dirname, "../lib/client.js");
await import(pathToFileURL(CLIENT_MODULE).href);
eq(loaders.length, 1, "bundle 被 loader 装载一次");
eq(loaders[0].id, "dsh-jobs-autoclose", "module id 必须是包名（loader 按 bundle 路径推期望 id）");
const inst = loaders[0].factory(() => { throw new Error("no platform modules should be required"); });
ok(typeof inst.apply === "function", "导出 apply");
eq(inst.inject.join(","), "sessions,betterSidebar", "inject 声明");

const TASKS_TAB = { id: "subagent", kind: "subagent", title: "任务管理" };

function makeCtx(opts = {}) {
	const subs = []; const disposers = []; const closes = []; const toggles = []; const opens = []; const focuses = [];
	/* 列表快照按**实测真形状**搭 —— 两个字面来源：实机自检 `shapes.listTopKeys`，与源码
	   `@deepseek-ai/dsh-api-session-controller/lib/client.js:3416-3424` 的 `this.list.set({…})`：
	   `{ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress }`，
	   行在 `byId`（`{ id, displayTitle, running:boolean, blank, updatedAt, … }`）。
	   ⚠️ 桩曾照想象搭成 `{ sessions: [] }`、后又照错来源搭成 `{ items: [] }`（那是 manager 的投影），
	   两次都让「永远是空数组」这个错一路绿灯。**桩的形状必须来自实机自检或该包的 list.set 行。** */
	/* `current` / `subagentsByParent` 是第 3 版「打开」路径要读的两个键 —— 两个字面出处：
	   ① 实机自检 `shapes.listTopKeys` 报出的七键里含它们；② 源码 `:3416-3424` 的 `this.list.set({…})`。 */
	const feed = { ids: [], byId: {}, current: opts.current ?? "s1", phase: "ready", jobsBySession: {} };
	if (opts.subagents === "missing") { /* 刻意不设该键：第 3 版的「结构不认识」现场 */ }
	else feed.subagentsByParent = opts.subagents ?? {};
	const prefs = opts.prefs ?? { autoOpenJobs: true, autoOpenSubagent: true };
	let activeTab = opts.activeTab === undefined ? null : opts.activeTab;
	let expanded = opts.expanded !== false;
	let closeWorks = opts.closeWorks !== false;     // false = 关了还在（唯一 docked 页被保留）

	/* 快照读取计数：用例 18b 要造「会话行读得到、子代理判定数据整体读不到」的现场（fail-closed）。 */
	let reads = 0; let failFrom = null;
	const sessions = { list: {
		getSnapshot: () => { reads += 1; if (failFrom !== null && reads >= failFrom) throw new Error("snapshot unavailable"); return feed; },
		...(opts.noSubscribe === true ? {} : { subscribe: (fn) => { subs.push(fn); return () => {}; } }),
	} };
	const sidebar = {
		getSnapshot: () => ({ sessionId: "s1", state: { bottomSplits: null, bottomOpen: false }, prefs }),
		...(opts.noIsTabEnabled === true ? {} : { isTabEnabled: (id) => (opts.tabDisabled === true ? false : id === "subagent") }),
		closeTab: () => {},
	};
	const right = opts.noRight === true ? undefined : {
		active: () => activeTab,
		isExpanded: () => expanded,
		close: (tabId) => { closes.push(tabId); if (closeWorks) activeTab = null; },
		closeIn: () => {},
		toggleExpanded: () => { toggles.push(1); expanded = !expanded; },
		/* 打开路径的**真实契约**（service.d.ts:125 openTab / :130 close / :147 focus）：
		   `openTab(kind, options)` 打开该 kind 的页并让它成为活动页（store openContent :501 的
		   planSetExpanded(true) + planOpenContent）。桩照这个搭，否则「打开」测出的不是真行为。 */
		openTab: (kind, options) => {
			/* 真契约里这条路径会抛：kind 没注册（placeTab 里的 throw）、或没有 mounted seat（require()）。 */
			if (opts.openThrows === true) throw new Error('sidebarRight: no tab type is registered as "subagent"');
			opens.push({ kind, options }); activeTab = TASKS_TAB;
		},
		focus: (tabId) => { focuses.push(tabId); },
	};
	const ctx = { get: (n) => (n === "sessions" ? sessions : n === "betterSidebar" ? sidebar : n === "sidebarRight" ? right : undefined),
		effect: (fn) => { disposers.push(fn()); } };
	return { ctx, subs, disposers, closes, toggles, opens, focuses, feed,
		reads: () => reads, failSnapshotsFrom: (n) => { failFrom = n; },
		activate: () => { activeTab = TASKS_TAB; }, deactivate: () => { activeTab = null; } };
}


/** 按**实测真形状**写一行会话：行在 `byId`，顺序在 `ids`，行 id 字段是 `id`，「忙」是 `running` 布尔。 */
function setRow(h, running) {
	h.feed.ids = ["s1"];
	h.feed.byId = { s1: { id: "s1", displayTitle: "S1", running, blank: false, updatedAt: 0 } };
}
const ACTIVE = [{ id: "j1", status: "running" }, { id: "j2", status: "completed" }];
const SETTLED = [{ id: "j1", status: "completed" }, { id: "j2", status: "completed" }];

/**
 * 走到「轮结束、有活跃任务、页已自动打开」这一步。
 * 顺序刻意与真实一致：先有新任务 id → 面板打开并激活任务页 → 轮结束 arm。
 */
function armAutoOpened(opts = {}) {
	const h = makeCtx(opts);
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();   // 轮内
	h.feed.jobsBySession.s1 = ACTIVE; h.subs[0]();                      // 新任务出现（面板据此自动打开）
	if (opts.tabAlreadyActive !== true) h.activate();                   // 页面被激活（自动打开的跳变）
	h.subs[0]();
	setRow(h, false); h.subs[0]();      // 轮结束 → arm
	return h;
}

/* 1. 装载即自检：能力面 + 真实形状上报 */
{
	const h = makeCtx({ activeTab: TASKS_TAB });
	setRow(h, false);                                       // 探针在 mount 时就要能看到行
	inst.apply(h.ctx);
	await tick();
	eq(h.subs.length, 1, "用 subscribe 走事件驱动（非轮询）");
	const r = posts.at(-1).body;
	eq(r.caps.sidebarRight, true, "自检：sidebarRight 存在");
	eq(r.caps.active, true, "自检：sidebarRight.active 存在");
	eq(r.caps.close, true, "自检：sidebarRight.close 存在");
	eq(r.caps.listSnapshot, true, "自检：list.getSnapshot 存在");
	eq(r.shapes.activeTab.kind, "subagent", "自检：报出活动页 kind");
	eq(r.shapes.tasksTabEnabled, true, "自检：报出任务页是否启用");
	eq(r.shapes.autoOpenJobs, true, "自检：报出 autoOpenJobs");
	eq(r.version, "0.3.0", "版本号");
	ok(Array.isArray(r.shapes.listTopKeys) && r.shapes.listTopKeys.includes("byId") && r.shapes.listTopKeys.includes("ids"), "自检：列表顶层键含 ids/byId");
	eq(r.shapes.byIdCount, 1, "自检：报出 byId 行数");
	ok(Array.isArray(r.shapes.sessionRowKeys) && r.shapes.sessionRowKeys.includes("running"), "自检：会话行含 running 字段");
	eq(r.shapes.sessionRunning, false, "自检：报出会话 running 值（与种下的行一致）");
	eq(r.shapes.sessionIds.join(","), "s1", "自检：能读出 sessionId");
}

/* 1b. 读取面回归：只有 `sessions` 键（第 2 版的错形状）时读不到行 —— 必须能沿 items 读并 arm */
{
	const h = makeCtx();
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	h.feed.jobsBySession.s1 = ACTIVE; h.subs[0]();
	h.activate(); h.subs[0]();
	setRow(h, false); h.subs[0]();
	const armed = posts.some((p) => Array.isArray(p.body.decisions) && p.body.decisions.some((d) => String(d.message).indexOf("armed for") === 0));
	ok(armed, "读取面：沿 items 读到 running 跳变并 arm（写成 s.sessions 就永远读不到）");
}

/* 2. 轮结束但无活跃任务 → 不监听、不关闭 */
{
	const h = makeCtx();
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	h.feed.jobsBySession.s1 = [{ id: "jx", status: "completed" }];
	setRow(h, false); h.subs[0]();
	eq(h.closes.length, 0, "无活跃任务：不关");
}

/* 3. 正向：自动打开的任务页 + 全部停完 → 关一次，且只关一次 */
{
	const h = armAutoOpened();
	eq(h.closes.length, 0, "还有活跃项：不关");
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(h.closes.length, 1, "全部停完：关一次");
	eq(h.closes[0], "subagent", "关的是任务页的 tabId");
	h.subs[0](); h.subs[0]();
	eq(h.closes.length, 1, "已 disarm：不会再关一次");
}

/* 4. 反向：用户自己点的（激活前有输入）→ 绝不关 */
{
	const h = armAutoOpened({ tabAlreadyActive: true });
	userInput();                                  // 用户点了任务管理
	h.activate();                                 // 页面因此被激活
	h.subs[0]();
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(h.closes.length, 0, "用户碰过：绝不关");
}

/* 5. 反向：页面早就开着（本轮没有新的激活跳变）→ 不关 */
{
	const h = armAutoOpened({ activeTab: TASKS_TAB, tabAlreadyActive: true });
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(h.closes.length, 0, "没有激活跳变：不关");
}

/* 6. 反向：没有新任务 id 与激活配对（激活远晚于任务出现）→ 不关 */
{
	const h = makeCtx({ tabAlreadyActive: true });
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	h.feed.jobsBySession.s1 = ACTIVE; h.subs[0]();                 // 新任务
	setRow(h, false); h.subs[0](); // 隔了几拍才 arm
	advance(10000);                                                // 真的过了 10 s
	h.activate(); h.subs[0]();                                     // 之后才激活（远在 2.5 s 窗口之外）
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(h.closes.length, 0, "签名窗口对不上：不关");
}

/* 7. 反向：面板的自动打开开关关了 → 不关（对齐面板自己的守卫） */
{
	const h = armAutoOpened({ prefs: { autoOpenJobs: false, autoOpenSubagent: true } });
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(h.closes.length, 0, "autoOpenJobs=false：不关（那这页不可能是面板开的）");
}

/* 8. 反向：任务页被禁用 → 不关 */
{
	const h = armAutoOpened({ tabDisabled: true });
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(h.closes.length, 0, "isTabEnabled(subagent)=false：不关");
}

/* 9. 缺 sidebarRight → 只报告不动作，且不抛 */
{
	const h = makeCtx({ noRight: true });
	let threw = null;
	try { inst.apply(h.ctx); } catch (e) { threw = e; }
	eq(threw, null, "缺 sidebarRight 不抛");
	setRow(h, true); h.subs[0]();
	h.feed.jobsBySession.s1 = ACTIVE; h.subs[0]();
	setRow(h, false); h.subs[0]();
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();
	eq(posts.at(-1).body.caps.sidebarRight, false, "自检如实报告能力缺失");
}

/* 10. 关不掉（唯一 docked 页被原生保留）→ 退一步收起整栏，最终放弃且不循环 */
{
	const h = armAutoOpened({ closeWorks: false });
	h.feed.jobsBySession.s1 = SETTLED; h.subs[0]();       // 第一次：close
	eq(h.closes.length, 1, "先尝试 close");
	h.subs[0]();                                          // 第二拍：还在 → 收起整栏
	eq(h.toggles.length, 1, "close 无效 → 收起整栏一次");
	h.subs[0](); h.subs[0]();
	eq(h.toggles.length, 1, "仍不奏效 → 放弃，不再反复动作");
}

/* 11. 进入新一轮：先判关闭（若已可关）再停监听 */
{
	const h = armAutoOpened();
	h.feed.jobsBySession.s1 = SETTLED;
	setRow(h, true); h.subs[0]();   // 新一轮（含完成通知唤醒）
	eq(h.closes.length, 1, "新一轮到来时先结算关闭");
	setRow(h, false); h.subs[0]();
	eq(h.closes.length, 1, "已停监听：不再重复动作");
}

/* 12. 没有 subscribe → 退化为轮询（定时器挂上，stop 时清掉 + 拆掉输入探针） */
{
	const before = listeners.get("pointerdown")?.size ?? 0;
	const h = makeCtx({ noSubscribe: true });
	inst.apply(h.ctx);
	await tick();
	eq(posts.at(-1).body.caps.subscribed, false, "无 subscribe 时标记为轮询");
	ok(typeof h.disposers[0] === "function", "注册了可回收的 teardown");
	ok((listeners.get("pointerdown")?.size ?? 0) > before, "挂了捕获期用户输入探针");
	h.disposers[0]();
	eq((listeners.get("pointerdown")?.size ?? 0), before, "teardown 拆掉了输入探针");
}

/* ============================================================
   第 3 版新增行为：**子代理在跑 → 主动打开「任务管理」页**
   ============================================================ */

/** 只看最近一次推送的报告（posts 是跨用例累积的）。 */
const lastReport = () => posts.at(-1).body;
const decisionsOf = (body) => (Array.isArray(body.decisions) ? body.decisions : []);
const hasNote = (needle) => decisionsOf(lastReport()).some((d) => String(d.message).indexOf(needle) !== -1);
/** 宽容读最近一次打开判定：反向控制样本里这些字段可能整块不存在 —— 不让测试崩，交断言记账。 */
const lastOpen = () => lastReport().lastOpenDecision ?? {};
const lastOpenGuards = () => lastOpen().guards ?? {};
/** 按**实测真形状**造 `subagentsByParent` 的 catalog：
    形在 `dsh-api-session-controller/lib/client.js:2416-2434`（`{ entries, parentAvailable?, state, error }`），
    行形在 `:2856-2864`（`{ kind:"child", id, label?, hasChildren?, activity? }`），
    `activity` 取值域来自 `:2809`（`running ? "running" : "inactive"`）。 */
function catalog(children, state = "ready") {
	return { s1: { entries: children.map((c) => ({ kind: "child", id: c.id, label: c.id, activity: c.activity })), state, error: null } };
}
const LIVE_CHILD = [{ id: "c-1", activity: "running" }];

/** 走到「轮结束、无 live 后台任务、有 live 子代理」这一步 —— 第 3 版的 arm 现场。 */
function armSubagentOnly(opts = {}) {
	const h = makeCtx(Object.assign({ subagents: catalog(LIVE_CHILD) }, opts));
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	if (opts.userInputBeforeEnd === true) userInput();
	setRow(h, false); h.subs[0]();
	return h;
}

/* 13. 新用例①：有子代理存活 + 无历史后台任务 + 页关闭 + 无用户输入 → 应打开**一次** */
{
	const h = armSubagentOnly();
	eq(h.opens.length, 1, "13 打开一次");
	const opened = h.opens[0] ?? {};
	eq(opened.kind, "subagent", "13 打开的是任务管理页（kind=subagent）");
	eq(opened.options, undefined, "13 不传任何 placement（不替换、不指定 pane、不动别的页）");
	eq(h.focuses.length, 0, "13 不额外调用任何焦点 API");
	eq(h.closes.length, 0, "13 打开路径里没有任何关闭动作");
	const body = lastReport();
	const ev = decisionsOf(body).filter((d) => d.event === "open-tasks-page");
	eq(ev.length, 1, "13 decisions 里有一条 open-tasks-page 事件");
	ok(String((ev[0] ?? {}).message).indexOf("guards: page=closed, input=quiet, prefs=allowed, tab=enabled, session=current, jobs=none-ever, subagents=live") !== -1,
		"13 打开事件写清了是哪几个守卫让它通过", String((ev[0] ?? {}).message));
	const od = body.lastOpenDecision ?? {};
	const g = od.guards ?? {};
	eq(od.opened, true, "13 lastOpenDecision.opened");
	eq(od.path, 'sidebarRight.openTab("subagent")', "13 报告里记下真实打开路径");
	eq(g.pageClosed, true, "13 守卫 pageClosed");
	eq(g.quiet, true, "13 守卫 quiet（无用户输入）");
	eq(g.prefsAllowed, true, "13 守卫 prefsAllowed");
	eq(g.tabEnabled, true, "13 守卫 tabEnabled");
	eq(g.sameSession, true, "13 守卫 sameSession");
	eq(g.noPriorJobs, true, "13 守卫 noPriorJobs");
	eq(g.liveSubagents, true, "13 守卫 liveSubagents");
	eq((od.liveSubagents ?? {}).count, 1, "13 报告里记下存活子代理数");
	ok(String((od.liveSubagents ?? {}).source).indexOf("catalog") === 0, "13 存活子代理读自 catalog", String((od.liveSubagents ?? {}).source));
}

/* 14. 新用例②：同上但用户刚有输入 → 不开 */
{
	const h = armSubagentOnly({ userInputBeforeEnd: true });
	eq(h.opens.length, 0, "14 用户刚有输入：不开");
	ok(String(lastOpen().reason).indexOf("user-typed") !== -1, "14 报告写明是 user-typed 否决", JSON.stringify(lastOpen().reason));
}

/* 15. 新用例③：同上但页已开着 → 不开（并退出监听） */
{
	const h = armSubagentOnly({ activeTab: TASKS_TAB });
	eq(h.opens.length, 0, "15 页已经开着：不开");
	ok(String(lastOpen().reason).indexOf("page-open") !== -1, "15 报告写明是 page-open 否决", JSON.stringify(lastOpen().reason));
	ok(hasNote("disarm: page-open"), "15 页已开着 → 退出监听，不空转");
}

/* 16. 新用例④：本轮已开过一次、用户又把它关了 → **不再开**（边沿触发 + 记住被拒） */
{
	const h = armSubagentOnly();
	eq(h.opens.length, 1, "16 先打开一次");
	h.deactivate(); h.subs[0]();          // 用户把它关了
	h.subs[0](); h.subs[0](); h.subs[0]();
	eq(h.opens.length, 1, "16 用户关掉后本轮不再打开（防骚扰优先）");
	ok(decisionsOf(lastReport()).some((d) => d.event === "open-tasks-page-skipped" && String(d.message).indexOf("本轮不再打开") !== -1),
		"16 报告写明「本轮不再打开」");
}

/* 17. 新用例⑤：本会话已有后台任务 → 不开（那种场景本来就由后台任务触发打开） */
{
	const h = makeCtx({ subagents: catalog(LIVE_CHILD) });
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	h.feed.jobsBySession.s1 = [{ id: "job-x", status: "running" }]; h.subs[0]();     // 产生过后台任务
	h.feed.jobsBySession.s1 = [{ id: "job-x", status: "completed" }]; h.subs[0]();   // 任务结束，镜像里随之消失
	setRow(h, false); h.subs[0]();                                                   // 轮结束
	eq(h.opens.length, 0, "17 本会话产生过后台任务：不开");
	ok(String(lastOpen().reason).indexOf("had-jobs") !== -1, "17 报告写明是 had-jobs 否决", JSON.stringify(lastOpen().reason));
}

/* 18a. 新用例⑥-1：判定结构不认识（catalog.entries 不是数组）→ 不开（fail-closed） */
{
	const h = makeCtx({ subagents: { s1: { entries: "nope", state: "ready" } } });
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	setRow(h, false); h.subs[0]();
	eq(h.opens.length, 0, "18a 结构不认识：不开");
	eq(decisionsOf(lastReport()).filter((d) => d.event === "open-tasks-page").length, 0, "18a 没有任何打开事件");
	ok(hasNote("no live job / no live subagent") === true, "18a catalog 认不出、会话行也没有子代理 → 只判「没有」，不 arm");
}

/* 18b. 新用例⑥-2：判定数据整体不可读 → 不监听（fail-closed）。
   快照读取顺序（这一拍）：① sessionRows ② readJobs ③ armIfActive 里的 readJobs
   ④ subagentMap ⑤ liveSubagents 的会话行 —— 从第 4 次起抛错，正好让子代理判定数据整块不可读。 */
{
	const h = makeCtx({ subagents: catalog(LIVE_CHILD) });
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	h.failSnapshotsFrom(h.reads() + 4);
	setRow(h, false); h.subs[0]();
	eq(h.opens.length, 0, "18b 数据整体不可读：不开（fail-closed）");
	ok(decisionsOf(lastReport()).some((d) => d.event === "open-tasks-page-skipped" && String(d.message).indexOf("fail-closed") !== -1),
		"18b 报告写明 fail-closed 不监听");
}

/* 18c. 冗余来源：catalog 结构不认识、但**会话行**里的子代理行显示 running
   → 兜底判定为「有存活子代理」，守卫全过时仍照常打开。
   会话行那条判据的出处：dsh-better-sidebar :11092-11097 directSubagentCount（origin/parentId）
   与 :11062 的 `running === true`。 */
{
	const h = makeCtx({ subagents: { s1: { entries: "nope", state: "ready" } } });
	inst.apply(h.ctx);
	setRow(h, true); h.subs[0]();
	h.feed.ids = ["s1", "s-child-1"];
	h.feed.byId = {
		s1: { id: "s1", displayTitle: "S1", running: true, blank: false, updatedAt: 0 },
		"s-child-1": { id: "s-child-1", displayTitle: "child", running: true, blank: false, updatedAt: 0, parentId: "s1", origin: "subagent" },
	};
	h.subs[0]();
	h.feed.byId = { ...h.feed.byId, s1: { ...h.feed.byId.s1, running: false } };
	h.subs[0]();
	eq(h.opens.length, 1, "18c catalog 认不出时会话行兜底：判定有存活子代理并打开");
	eq(String((lastOpen().liveSubagents ?? {}).source), "rows", "18c 报告写明用的是兜底来源");
}

/* 19. 约束①：插件自己打开的页，子代理跑完后**绝不自我关闭**（关闭/打开时间窗互斥） */
{
	const h = armSubagentOnly();
	eq(h.opens.length, 1, "19 先打开成功");
	h.feed.subagentsByParent.s1 = { entries: [{ kind: "child", id: "c-1", activity: "inactive" }], state: "ready" };
	h.subs[0]();
	eq(h.closes.length, 0, "19 子代理跑完也不关（这一页是插件自己开的）");
	eq(h.toggles.length, 0, "19 不收起整栏");
	ok(hasNote("disarm: subagent-settled"), "19 退出监听：subagent-settled");
}

/* 20. 约束①：打开动作把基线与信号在**打开那一刻**写好 —— 既不冒充「面板自动打开」，
   也不把用户随后关掉它的那次跳变跨拍漏掉（关闭判定不被打开动作污染）。 */
{
	const h = armSubagentOnly();
	eq(lastOpen().opened, true, "20 先打开成功");
	h.subs[0]();
	eq(hasNote("(opened by this plugin)"), false, "20 打开造成的跳变不当成「新激活」再记一遍（基线在打开时就推到位）");
	h.deactivate(); h.subs[0]();
	ok(hasNote("本轮不再打开"), "20 用户关掉它能被立刻观测到（基线正确，没有跨拍丢失）");
	eq(lastReport().lastDecision, undefined, "20 打开模式的 arm 不跑关闭判定（不开辟关闭窗口，也就无从被污染）");
}

/* 21. 打开路径抛错（kind 未注册 / 无 mounted seat，service.d.ts:1226 的 require() 会喊）→ 只上报，不抛、不反复动作 */
{
	let threw = null;
	const h = makeCtx({ subagents: catalog(LIVE_CHILD), openThrows: true });
	try { inst.apply(h.ctx); setRow(h, true); h.subs[0](); setRow(h, false); h.subs[0](); } catch (e) { threw = e; }
	eq(threw, null, "21 打开抛错不冒泡到客户端上下文");
	eq(h.opens.length, 0, "21 抛错不算「已打开」");
	h.subs[0](); h.subs[0]();
	eq(h.closes.length, 0, "21 后续拍不反复动作、也不关任何页");
	ok(decisionsOf(lastReport()).some((d) => d.event === "open-tasks-page-skipped" && String(d.message).indexOf("threw") !== -1), "21 报告写明是 open-throw");
	eq(String(lastOpen().reason).indexOf("open-throw") === 0, true, "21 lastOpenDecision 记下抛错原因", String(lastOpen().reason));
}

/* 22. 缺 ctx.sidebarRight → 只上报不动作（fail-soft），且不抛（第 3 版路径同样受这条纪律约束） */
{
	let threw = null;
	const h = makeCtx({ subagents: catalog(LIVE_CHILD), noRight: true });
	try { inst.apply(h.ctx); setRow(h, true); h.subs[0](); setRow(h, false); h.subs[0](); } catch (e) { threw = e; }
	eq(threw, null, "22 缺 sidebarRight 不抛");
	eq(h.opens.length, 0, "22 缺 sidebarRight 不开");
	ok(String(lastOpen().reason).indexOf("no-api") !== -1, "22 报告写明 no-api", JSON.stringify(lastOpen().reason));
	eq(lastReport().caps.sidebarRight, false, "22 自检如实报告能力缺失");
}

/* 23. 约束①终检：插件自己打开的页**一直开着**（用户没关）→ 下一轮带后台任务结束时，
   `self-opened` 守卫必须挡在关闭路径前面（而不是让 bySelf 之外的路径把它关掉）。 */
{
	const h = armSubagentOnly();
	eq(h.opens.length, 1, "23 先打开成功");
	setRow(h, true); h.subs[0]();                                             // 用户又发一条（新一轮）
	h.feed.jobsBySession.s1 = [{ id: "job-y", status: "running" }]; h.subs[0]();  // 本轮起了后台任务
	setRow(h, false); h.subs[0]();                                              // 轮结束 → arm(close)，任务还活着
	eq(h.closes.length, 0, "23 任务还在跑：不关");
	h.feed.jobsBySession.s1 = [{ id: "job-y", status: "completed" }]; h.subs[0](); // 全停 → 才轮到关闭判定
	eq(h.closes.length, 0, "23 页是我开的：关闭路径不动它");
	ok(hasNote("opened by the plugin itself"), "23 报告写明是 self-opened 守卫否决的");
	ok(hasNote("disarm: self-opened"), "23 并由 self-opened 退出监听");
}

if (failures.length === 0) console.log("ALL OK (" + passed + " assertions)");
else { console.log("FAILED " + failures.length + " / " + (passed + failures.length)); for (const f of failures) console.log("  · " + f); process.exitCode = 1; }

/* 用例 12 起了轮询定时器（无 subscribe 的降级路径）会一直重排 → 这里显式收尾，
   否则 node 事件循环被吊住、进程永不退出（插件侧无泄漏：真实运行时由 ctx.effect 回收）。 */
process.exit(failures.length === 0 ? 0 : 1);
