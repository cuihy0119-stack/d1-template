// 把 KaTeX 打包进 public/katex（不依赖外部 CDN，国内网络也稳定）。升级 katex 后运行：node scripts/vendor-katex.mjs
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
const src = "node_modules/katex/dist", out = "public/katex";
rmSync(out, { recursive: true, force: true });
mkdirSync(out + "/fonts", { recursive: true });
for (const f of ["katex.min.css", "katex.min.js", "contrib/auto-render.min.js", "contrib/mhchem.min.js"]) cpSync(`${src}/${f}`, `${out}/${f.split("/").pop()}`);
for (const f of readdirSync(src + "/fonts")) if (f.endsWith(".woff2")) cpSync(`${src}/fonts/${f}`, `${out}/fonts/${f}`); // 现代浏览器只用 woff2
