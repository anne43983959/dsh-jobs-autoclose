/**
 * dsh-jobs-autoclose · 宿主半（极薄）
 *
 * 职责只有两件：
 *   ① 让客户端半有东西可挂（宿主半存在 = 该包被装载）；
 *   ② 提供一条上报路由，把客户端半在**真实运行时**里探到的接口形状带回来，
 *      供开发者核对（`POST /api/jobs-autoclose/report` 写入、`GET` 读回）。
 *
 * 决策全在客户端半：只有浏览器侧才拿得到会话任务流（ctx.sessions.list）与
 * 侧边栏标签状态（ctx.betterSidebar），宿主侧拿不到「哪个标签是用户点的」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "jobs-autoclose";
export const inject = ["connection"];

/** 报告落盘位置：与 dsh-sandbox-sweep 的台账同款约定（$DSH_HOME/<插件名>/）。
 *  为什么要落文件：`/api/**` 路由要带会话令牌，从 shell 里 curl 会吃 401，
 *  落一份到磁盘才能让开发者（或下一次会话的 agent）直接读。 */
const REPORT_DIR = join(process.env.DSH_HOME ?? process.cwd(), "jobs-autoclose");

/** 尽力而为地落盘，失败只记日志、不影响路由响应。 */
async function persist(ctx, payload) {
	try {
		await mkdir(REPORT_DIR, { recursive: true });
		await writeFile(join(REPORT_DIR, "report.json"), JSON.stringify(payload, null, 2), "utf8");
	} catch (error) {
		ctx.logger.warn(`jobs-autoclose: report persist failed: ${String(error)}`);
	}
}

/** 最近一次客户端自检报告（进程内保留一份，重启即清空）。 */
let lastReport = { receivedAt: null, report: null };

/**
 * 注册上报/读回两条路由。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
	/** 路由契约（0.1.5-rc.3 实测，两处都载过跟头）：
	 *  ① `requestBody: "buffered"` 只表示宿主已把整包收进内存，**不等于**已解析 ——
	 *     `fetch(request)` 拿到的是标准 `Request`，`request.body` 是 ReadableStream，
	 *     直接 `JSON.parse` 得到的是 `"[object ReadableStream]"`。读正文必须 `await request.text()`。
	 *  ② 返回值必须是真 `Response`（`{ content: [...] }` 那套是 RPC 通道的形，不是 Fetch 路由的形）。
	 */
	const json = (value, status = 200) => Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
	ctx.effect(() => ctx.connection.fetch.register({
		path: "/api/jobs-autoclose/report",
		methods: ["POST", "GET"],
		requestBody: "buffered",
		fetch: async (request) => {
			if (request.method === "GET") return json(lastReport);
			let text = "";
			try { text = await request.text(); } catch (error) { ctx.logger.warn(`jobs-autoclose: body read failed: ${String(error)}`); }
			let body = null;
			try { body = JSON.parse(text === "" ? "{}" : text); } catch { body = { parseError: true, raw: text.slice(0, 400) }; }
			lastReport = { receivedAt: new Date().toISOString(), report: body };
			ctx.logger.info("jobs-autoclose: client report received");
			await persist(ctx, lastReport);
			return json({ ok: true });
		},
	}), "jobs-autoclose: report route");
}
