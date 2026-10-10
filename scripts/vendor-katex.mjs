// 把 KaTeX、MathLive 打包进 public（不依赖外部 CDN，国内网络也稳定）。升级后运行：npm run vendor
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
const src = "node_modules/katex/dist", out = "public/katex";
rmSync(out, { recursive: true, force: true });
mkdirSync(out + "/fonts", { recursive: true });
for (const f of ["katex.min.css", "katex.min.js", "contrib/auto-render.min.js", "contrib/mhchem.min.js"]) cpSync(`${src}/${f}`, `${out}/${f.split("/").pop()}`);
for (const f of readdirSync(src + "/fonts")) if (f.endsWith(".woff2")) cpSync(`${src}/fonts/${f}`, `${out}/fonts/${f}`); // 现代浏览器只用 woff2
// MathLive（计算解答板的公式输入）：字体与 KaTeX 同名，直接用 /katex/fonts，不另存
mkdirSync("public/mathlive", { recursive: true });
for (const f of ["mathlive.min.js", "LICENSE.txt"]) cpSync(`node_modules/mathlive/${f}`, `public/mathlive/${f}`);
