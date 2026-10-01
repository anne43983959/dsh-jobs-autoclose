/**
 * 冻结的反向控制样本 —— **故意保留两个真实踩过的坑**，不要修它、不要照抄它。
 *
 * 它存在的唯一目的：证明 `.smoke/host-test.mjs` 有牙齿 ——
 *   `JA_HOST_MODULE=fixtures/host-legacy-buggy.mjs node .smoke/host-test.mjs` 必须 FAILED。
 * 若某天它变成 ALL OK，说明测试被削弱了。
 *
 * 两个坑（2026-09-29 实机首轮报告 126 B 全是 parseError 的成因）：
 *   ① `JSON.parse(request.body)` —— `request.body` 是 ReadableStream，不是字符串；
 *   ② 返回 `{ content: [...] }` —— 那是 RPC 通道的形，Fetch 路由要真 `Response`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "jobs-autoclose";
export const inject = ["connection"];

const REPORT_DIR = join(process.env.DSH_HOME ?? process.cwd(), "jobs-autoclose");

async function persist(ctx, payload) {
	try {
		await mkdir(REPORT_DIR, { recursive: true });
		await writeFile(join(REPORT_DIR, "report.json"), JSON.stringify(payload, null, 2), "utf8");
	} catch (error) {
		ctx.logger.warn(`jobs-autoclose: report persist failed: ${String(error)}`);
	}
}

let lastReport = { receivedAt: null, report: null };

export function apply(ctx) {
	const reply = (value) => ({
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	});
	ctx.effect(() => ctx.connection.fetch.register({
		path: "/api/jobs-autoclose/report",
		methods: ["POST", "GET"],
		requestBody: "buffered",
		fetch: async (request) => {
			if (request.method === "GET") return reply(lastReport);
			let body = null;
			try { body = JSON.parse(request.body ?? "{}"); } catch { body = { parseError: true, raw: String(request.body).slice(0, 400) }; }
			lastReport = { receivedAt: new Date().toISOString(), report: body };
			ctx.logger.info("jobs-autoclose: client report received");
			await persist(ctx, lastReport);
			return reply({ ok: true });
		},
	}), "jobs-autoclose: report route");
}
