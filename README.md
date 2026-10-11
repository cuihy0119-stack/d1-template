# MAX NOTE

（原名「错题练习站」。）

只给自己用的手机刷题网站（Cloudflare Workers + Hono + D1（照片也存 D1，不需要 R2））。网站里的助手 Max 用 Cloudflare Workers AI + DeepSeek；出题、批改、总结也可由 claude.ai 通过 MCP（阶段二）完成。

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
2. 名称随意（如「MAX NOTE」），URL 填上面的 `/mcp` 地址，保存
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

- 首页：今日练习、Max 建议、拍照上传、各科概览；底部导航 首页 / 题库 / 错题本（线条图标）
- 题库、错题本：按 科目 → 分类（章节）→ 考点 分组，点题目看答案、解析和历史作答，可「练这组」「重做」
- 题型标签：Claude 出题只给 `tag`（选择/填空/计算/解答/证明/作图/函数/电路/简答），网站自动定题型和画板（计算、解答→计算板；证明、作图→方格；函数→坐标系；电路→电路图板）；`organize` 可改标签。简答题也可按科目手动开画板，可同时开多个：
  - 🧮 **计算解答板**（`calc`，数学/物理）：横线纸手写板，和作图板同一套代码（画笔、颜色粗细、文字、橡皮点/划删、撤销重做、放大）；「＝算式」写完自动出得数（小数自动化成分数、根式化简如 4√3；画板上的分数写成竖式 ¾，后面附小数），方程自动解（如 x²-5x+6=0 → x=2，x=3）；🧮 计算器可把结果贴到画板；可展开「打字整理步骤」（MathLive 公式输入，初中定制键盘）。交卷发文字，手写了才附图
  - 物理 🔌 **电路图板**（`circuit`）：电源、开关（点一下通断）、灯泡、定值电阻、滑动变阻器、电流表、电压表、电动机、电铃、LED；导线自动折直角，三线交汇自动画连接点。交卷时代码算出网表（各元件接哪两个节点）并提示并联、短接、断头
  - 数学 📐 **几何函数板**（`coord|grid`，其它科目也用它）：在题目下方直接显示作图板，方格常驻。格点吸附，按住时显示十字辅助线和坐标气泡（手指挡住也能看准，松手落点）；撤销/重做在画板正上方；直线/射线自动延长到边缘带箭头；标点时起名并自动写坐标（如 A(1,-4)）；可在画板上直接打字；另有圆、多边形、平滑曲线、垂线、平行线、函数自动画图、画笔、橡皮、虚线、撤销/重做
- 分类由 Claude 维护：可对它说「按我 Notion 错题库的分类整理题库」，它用 `get_question_bank` + `organize_questions` 调整，也可以把错题同步到 Notion（网站本身不连 Notion）

### Max 助手（悬浮球）

- 输入框上面两个标签，点一下开、再点关（只记在当前标签页）：
  - **深度思考**：只用 DeepSeek 的思考模型（`deepseek-reasoner`，可用 `DEEPSEEK_REASONER_MODEL` 改），想得更深更慢；没接 DeepSeek 或当天额度用完时会提示。
  - **联网搜索**：先搜网页再回答，结尾写来源。依次试 Tavily（设了 `TAVILY_API_KEY` 密钥才用，最稳）→ Bing 网页 → DuckDuckGo 网页 → 中文维基；都不行时如实说没搜到。
- **练题**：Max 回答里的「练：科目/考点」按钮 → `/quiz?topic=科目/考点`。题库里有同类题（考点、章节或题型标签匹配）就直接练；没有就让 Max **现场出 10 道以内**的临时题（只出选择/填空）：不进题库、不进错题本和做题记录；答完当场判分，错了只提示，可点「让 Max 分析」（把这道题和你的答案带给 Max）。
- **清理题库**：对 Max 说「把集合的题删了 / 清掉做过的」，它会给出「清理题库：科目/考点」按钮，点了先数一数、你确认才删（只删还显示着的题；待批改的、做题记录都保留）。

## 错题 → Notion 笔记（不用 AI）

做错题后，结果页、错题本详情、Max 临时练习里会出现「Notion 笔记：xx」按钮，Max 讲错题时也会给。后端用 Notion 官方接口按**考点名**搜页面标题（完全一样 > 标题含考点 > 考点含标题），找到才显示；结果缓存（找到 7 天、没找到 1 天）。设置：
1. https://www.notion.so/my-integrations 新建「内部集成」，复制密钥
2. Cloudflare Worker → Settings → Variables and Secrets 加密钥 `NOTION_TOKEN`
3. Notion 里打开存笔记的页面 → 右上角 ⋯ → 连接 → 选这个集成（子页面自动包含）
4. 反过来：Notion 考点页放链接 `https://你的域名/quiz?topic=科目/考点`，直达站内同标签题（没有就让 Max 出临时题）

# 本地开发

```bash
cp .dev.vars.example .dev.vars   # 改成你的口令
npm run dev                      # 自动建本地 D1，http://localhost:8787
npm run seed:local               # 导入 seed/questions.json
```

## 题库生命周期（自动精简）

- **题库时效**：题目出现超过 **24 小时就隐藏**（题库、错题本、今日练习、Max 都不再显示），不管做没做、是不是错题；**没重做的错题加长到 48 小时**；错题重做做对 → 放进「错题文件夹」（不受时效限制，攒满 20 道发给 Claude）。隐藏满 30 天后每日定时清理才真删，做题记录一直保留
- 题目状态：`active` 在用 / `mastered` 错题重做做对（错题文件夹）/ `done` 第一次就做对（隐藏）；done 的 30 天后自动删
- 错题本分「复习中 / 已掌握」两页，每题可「删除」「标为已掌握」；删题不删作答记录（attempts 冗余存了 subject、topic）
- 每日 Cron（北京时间 03:17）：mastered/done 超过 30 天删题（题库里隐藏满 30 天的也清掉）；已批改作答的照片超过 30 天删除；已处理的上传超过 14 天删除；总结只留最近 30 条
- Claude 查题库（`get_data kind=bank`）默认只看复习中的题，`all=true` 才列全部；作答记录不受删题影响

## 规则速记

- 今日练习 = 到期错题 + 未做过的新题（`source=同类题`），都只含还没过时效的题
- 做错 → 进错题本，明天重做；重做做对 → 已发给 Claude 的隐藏，没发过的留在错题本（显示「重做已对」）
- 错题本里没发过的错题攒到 20 道（或满 7 天）→ 在 Claude 收件箱/保存的返回里整包附上（后端整理好错答、错因等），Claude 讲解并问是否归档 Notion；错题重做页不显示标记按钮
- 选择/填空当场判分（去空格、全角转半角，填空可有多个可接受答案）；简答标「待批改」
- 日期按北京时间

> 部署由 Cloudflare Workers Builds 从 `main` 自动触发。
