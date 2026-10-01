/**
 * dsh-jobs-autoclose · 宿主半离线冒烟
 *
 * 复现并锁死两个真实踩过的坑（实机 2026-09-29 首轮报告 126 B 全是 parseError）：
 *   ① `fetch(request)` 收到的是标准 `Request` —— `requestBody: "buffered"` 只是
 *      说宿主已把整包收进内存，`request.body` 仍是 ReadableStream。
 *      直接 `JSON.parse(request.body)` 得到 `"[object ReadableStream]"` → parseError。
 *   ② Fetch 路由必须返回真 `Response`；返回 `{ content: [...] }`（RPC 通道的形）
 *      在下游会炸。
 *
 * 不碰真实 home：先把 DSH_HOME 指到本目录下的临时目录，再动态 import 宿主半。
 * 末尾 process.exit：与 client-test.mjs 同款纪律。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 以本文件位置定位宿主半 —— 不依赖 cwd（实测从工作区根调用时 process.cwd() 不是插件目录）。 */
const HOST_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
const failures = [];
function ok(label, condition, detail) {
	if (condition) { pass += 1; return; }
	failures.push(label + (detail === undefined ? "" : " :: " + detail));
}

const fakeHome = await mkdtemp(join(tmpdir(), "jobs-autoclose-smoke-"));
process.env.DSH_HOME = fakeHome;

/** 可用 JA_HOST_MODULE 指向另一份宿主半实现 —— 用于反向控制（见 fixtures/host-legacy-buggy.mjs）。 */
const HOST_MODULE = process.env.JA_HOST_MODULE ?? join(HOST_DIR, "lib", "index.js");
const mod = await import(pathToFileURL(HOST_MODULE).href);

// ---- 桩 ctx：捕获注册进来的路由 ----
let route = null;
const warnings = [];
const stub = {
	logger: { warn: (m) => warnings.push(m), info: () => {} },
	effect: (fn) => fn(),
	connection: { fetch: { register: (r) => { route = r; return () => {}; } } },
};

ok("导出 name", mod.name === "jobs-autoclose", String(mod.name));
ok("导出 inject 含 connection", Array.isArray(mod.inject) && mod.inject.includes("connection"), JSON.stringify(mod.inject));
ok("导出 apply 是函数", typeof mod.apply === "function");

mod.apply(stub);
ok("路由已注册", route !== null && typeof route === "object");
ok("路由 path", route?.path === "/api/jobs-autoclose/report", String(route?.path));
ok("路由 methods", Array.isArray(route?.methods) && route.methods.join(",") === "POST,GET", JSON.stringify(route?.methods));
ok("路由 requestBody=buffered", route?.requestBody === "buffered", String(route?.requestBody));
ok("路由 fetch 是函数", typeof route?.fetch === "function");

/** 宽容读响应体：反向控制样本返回的不是 Response，这里取不到就返回 null 交给断言记账，
 *  而不是让整个用例抛出来把后面的断言一起吞掉（否则反向控制只报 TypeError、看不到失败清单）。 */
async function jsonOf(res) {
	if (res === null || res === undefined || typeof res.json !== "function") return null;
	try { return await res.json(); } catch { return null; }
}
/** 宽容读落盘报告：文件可能根本没被写出来。 */
async function fileReport() {
	try { return JSON.parse(await readFile(reportPath, "utf8")); } catch { return null; }
}

const URL_ = "http://127.0.0.1:64733/api/jobs-autoclose/report";
const reportPath = join(fakeHome, "jobs-autoclose", "report.json");

// ---- 用例 1：正常 JSON 上报（回归①：body 必须被解析出来） ----
const payload = { plugin: "jobs-autoclose", version: "0.1.0", caps: { closeTab: true }, shapes: { sidebarSnapshotKeys: ["tabs", "activeTabId"] }, decisions: [{ at: 1, message: "caps probed" }] };
const res1 = await route.fetch(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
ok("用例1 返回真 Response", res1 instanceof Response, "得到 " + Object.prototype.toString.call(res1));
ok("用例1 status 200", res1?.status === 200, String(res1?.status));
const body1 = await jsonOf(res1);
ok("用例1 响应 {ok:true}", body1?.ok === true, JSON.stringify(body1));

const persisted1 = await fileReport();
ok("用例1 落盘无 parseError", persisted1 !== null && persisted1.report?.parseError === undefined, JSON.stringify(persisted1)?.slice(0, 200));
ok("用例1 落盘内容一致（caps）", persisted1?.report?.caps?.closeTab === true, JSON.stringify(persisted1?.report?.caps));
ok("用例1 落盘内容一致（decisions 非空）", Array.isArray(persisted1?.report?.decisions) && persisted1.report.decisions.length === 1);
ok("用例1 落盘带 receivedAt", typeof persisted1?.receivedAt === "string" && persisted1.receivedAt.includes("T"), String(persisted1?.receivedAt));
ok("用例1 无 warn", warnings.length === 0, JSON.stringify(warnings));

// ---- 用例 2：GET 读回同一份 ----
const res2 = await route.fetch(new Request(URL_, { method: "GET" }));
ok("用例2 GET 返回真 Response", res2 instanceof Response);
const body2 = await jsonOf(res2);
ok("用例2 GET 读回同一份 report", body2?.report?.version === "0.1.0", JSON.stringify(body2).slice(0, 160));

// ---- 用例 3：空正文 -> {}，不算错 ----
const res3 = await route.fetch(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "" }));
ok("用例3 空正文返回 Response", res3 instanceof Response);
const persisted3 = await fileReport();
ok("用例3 空正文解析为 {}", persisted3?.report !== undefined && persisted3.report.parseError === undefined, JSON.stringify(persisted3?.report));

// ---- 用例 4：坏 JSON -> parseError + raw 片段（保留诊断，不抛） ----
const res4 = await route.fetch(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }));
ok("用例4 坏 JSON 仍返回 Response", res4 instanceof Response);
const persisted4 = await fileReport();
ok("用例4 标记 parseError", persisted4?.report?.parseError === true, JSON.stringify(persisted4?.report));
ok("用例4 保留 raw 原文", persisted4?.report?.raw === "{not json", String(persisted4?.report?.raw));

// ---- 用例 5：request.body 仍是流（说明为什么不能直接用） ----
const probe = new Request(URL_, { method: "POST", body: "{}" });
ok("用例5 request.body 是 ReadableStream", typeof ReadableStream !== "undefined" && probe.body instanceof ReadableStream);
ok("用例5 String(request.body) 即旧 bug 的产物", String(probe.body) === "[object ReadableStream]", String(probe.body));

await rm(fakeHome, { recursive: true, force: true });

if (failures.length === 0) {
	console.log(`ALL OK (${pass} assertions)`);
	process.exit(0);
}
console.log(`FAILED (${pass} passed, ${failures.length} failed)`);
for (const f of failures) console.log("  ✗ " + f);
process.exit(1);
