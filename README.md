# 错题练习站

只给自己用的手机刷题网站（Cloudflare Workers + Hono + D1（照片也存 D1，不需要 R2））。网站不调用任何 AI；出题、批改、总结由 claude.ai 通过 MCP（阶段二）完成。

当前进度：阶段一（网站）、阶段二（`/mcp` + OAuth）均已完成。

## 部署步骤（阶段一）

1. `npm install`，`npx wrangler login`
2. 部署（会自动执行 D1 迁移）：`npm run deploy`
3. 设置登录口令：`npx wrangler secret put PASSCODE`
   （或控制台 Worker → Settings → Variables and Secrets 添加 `PASSCODE`）
4. 导入几道测试题（可选）：`npm run seed:remote`

> 用 Cloudflare 的 Git 集成（Workers Builds）时，Deploy command 填 `npm run deploy`，口令在控制台添加。

## 连接 claude.ai（阶段二）

MCP 地址：`https://<你的 Worker 域名>/mcp`（例如 `https://d1-template.cuihy0119.workers.dev/mcp`）

1. claude.ai → 设置 → 连接器 → **添加自定义连接器**
2. 名称随意（如「错题练习站」），URL 填上面的 `/mcp` 地址，保存
3. 点连接，会弹出授权页，输入网站的 `PASSCODE` 并点「允许」
4. 对话里就能让 Claude 用这些工具：`get_inbox`、`add_wrong_questions`、`add_questions`、`grade`、`get_records`、`post_summary`，以及分类用的 `get_question_bank`、`organize_questions`

OAuth 的令牌存在 KV（绑定名 `OAUTH_KV`）。`wrangler.json` 里没写 KV id，首次 `wrangler deploy` 会自动创建；若构建报 KV 权限错误，手动在控制台建一个 KV，把 id 填进 `kv_namespaces`。

典型用法：
- 拍照上传错题 → 对 Claude 说「处理收件箱」→ 它整理错题、出同类题推送到「今日练习」
- 你做完交卷 → 对 Claude 说「批改并总结」→ 它批改简答、统计分析并写总结

## 页面与分类

- 首页：今日练习、拍照上传、Claude 总结、各科概览；底部导航 首页 / 题库 / 错题本
- 题库、错题本：按 科目 → 分类（章节）→ 考点 分组，点题目看答案、解析和历史作答，可「练这组」「重做」
- 作图题（Claude 出题时设 `board: coord|grid`）在题目下方直接显示作图板；其他简答题可手动打开。方格常驻，工具：画笔、线段、直线、射线、圆、矩形、多边形、平滑曲线、点（命名）、文字、垂线（带直角符号）、平行线、函数自动画图、橡皮，及颜色/粗细/虚线/吸附格点/坐标轴/撤销/重做/放大。交卷时导出为图片，Claude 在 `get_inbox` 里读图批改
- 分类由 Claude 维护：可对它说「按我 Notion 错题库的分类整理题库」，它用 `get_question_bank` + `organize_questions` 调整，也可以把错题同步到 Notion（网站本身不连 Notion）

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
