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
4. 对话里 Claude 只用 3 个工具：
   - `get_inbox`：新照片 + 待批改作答
   - `save`：一次写入——`grades` 批改、`wrong` 原错题、`questions` 新题、`organize` 改分类、`summary` 总结；`def` 给本批题共用的科目/章节；`type` 可省（自动推断）
   - `get_data`：`kind=records` 作答记录 / `kind=bank` 题库清单（TSV）

省用量设计：工具少且说明短；一轮通常只要 get_inbox + save 两次调用；作图答案转成文字描述（坐标单位=格），只有手绘才附图；照片压到 1280px。

OAuth 的令牌存在 KV（绑定名 `OAUTH_KV`）。`wrangler.json` 里没写 KV id，首次 `wrangler deploy` 会自动创建；若构建报 KV 权限错误，手动在控制台建一个 KV，把 id 填进 `kv_namespaces`。

典型用法：
- 拍照上传错题 → 对 Claude 说「处理收件箱」→ 它整理错题、出同类题推送到「今日练习」
- 你做完交卷 → 对 Claude 说「批改并总结」→ 它批改简答、统计分析并写总结

## 页面与分类

- 首页：今日练习、拍照上传、Claude 总结、各科概览；底部导航 首页 / 题库 / 错题本
- 题库、错题本：按 科目 → 分类（章节）→ 考点 分组，点题目看答案、解析和历史作答，可「练这组」「重做」
- 作图题（Claude 出题时设 `board: coord|grid`）在题目下方直接显示作图板，方格常驻。格点吸附，按住时显示十字辅助线和坐标气泡（手指挡住也能看准，松手落点）；撤销/重做在画板正上方；直线/射线自动延长到边缘带箭头；标点自动写坐标；可在画板上直接打字；另有圆、多边形、平滑曲线、垂线、平行线、函数自动画图、画笔、橡皮、虚线、撤销/重做
- 分类由 Claude 维护：可对它说「按我 Notion 错题库的分类整理题库」，它用 `get_question_bank` + `organize_questions` 调整，也可以把错题同步到 Notion（网站本身不连 Notion）

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 改成你的口令
npm run dev                      # 自动建本地 D1，http://localhost:8787
npm run seed:local               # 导入 seed/questions.json
```

## 题库生命周期（自动精简）

- 题目状态：`active` 复习中 / `mastered` 已掌握（15 天关通过或手动标记）/ `done` 同类题第一次就做对（不进复习、不再出现在练习）
- 错题本分「复习中 / 已掌握」两页，每题可「删除」「标为已掌握」；删题不删作答记录（attempts 冗余存了 subject、topic）
- 每日 Cron（北京时间 03:17）：mastered/done 超过 30 天删题；已批改作答的照片超过 30 天删除；已处理的上传超过 14 天删除；总结只留最近 30 条
- Claude 查题库（`get_data kind=bank`）默认只看复习中的题，`all=true` 才列全部；作答记录不受删题影响

## 规则速记

- 今日练习 = 到期错题 + 未做过的新题（`source=同类题`）
- 做错 → 明天重做；重做对 → 按 1、2、4、7、15 天推进，15 天后算掌握；重做错 → 退回第 1 天
- 选择/填空当场判分（去空格、全角转半角，填空可有多个可接受答案）；简答标「待批改」
- 日期按北京时间

> 部署由 Cloudflare Workers Builds 从 `main` 自动触发。
