// 用法：node scripts/seed.mjs [--remote]   把 seed/questions.json 导入 D1
// 原错题会同时放进复习队列（今天到期，方便测试）。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const remote = process.argv.includes("--remote");
const q = (v) => (v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const items = JSON.parse(readFileSync("seed/questions.json", "utf8"));
let sql = "";
for (const x of items) {
	sql += `INSERT INTO questions (subject,category,topic,type,stem,options,answer,explanation,source,origin_id) VALUES (${[
		x.subject, x.category, x.topic, x.type, x.stem, x.options && JSON.stringify(x.options), JSON.stringify(x.answer), x.explanation, x.source, x.origin_id,
	].map(q).join(",")});\n`;
	if (x.source === "原错题") sql += `INSERT INTO review_queue (question_id,next_date,stage) VALUES (last_insert_rowid(),'${today}',0);\n`;
}
writeFileSync("seed/.seed.sql", sql);
execFileSync("npx", ["wrangler", "d1", "execute", "DB", remote ? "--remote" : "--local", "--file", "seed/.seed.sql"], { stdio: "inherit" });
