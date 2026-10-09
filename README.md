# 错题练习站

只给自己用的手机刷题网站（Cloudflare Workers + Hono + D1（照片也存 D1，不需要 R2））。网站不调用任何 AI；出题、批改、总结由 claude.ai 通过 MCP（阶段二）完成。

当前进度：**阶段一（网站）已完成**；阶段二（`/mcp` + OAuth）待做。

## 部署步骤（阶段一）

1. `npm install`，`npx wrangler login`
2. 部署（会自动执行 D1 迁移）：`npm run deploy`
3. 设置登录口令：`npx wrangler secret put PASSCODE`
   （或控制台 Worker → Settings → Variables and Secrets 添加 `PASSCODE`）
4. 导入几道测试题（可选）：`npm run seed:remote`

> 用 Cloudflare 的 Git 集成（Workers Builds）时，Deploy command 填 `npm run deploy`，口令在控制台添加。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 改成你的口令
npm run dev                      # 自动建本地 D1，http://localhost:8787
npm run seed:local               # 导入 seed/questions.json
```

## 规则速记

- 今日练习 = 到期错题 + 未做过的新题（`source=同类题`）
- 做错 → 明天重做；重做对 → 按 1、2、4、7、15 天推进，15 天后算掌握；重做错 → 退回第 1 天
- 选择/填空当场判分（去空格、全角转半角，填空可有多个可接受答案）；简答标「待批改」
- 日期按北京时间

> 部署由 Cloudflare Workers Builds 从 `main` 自动触发。
