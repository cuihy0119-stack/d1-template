// 出题模板（get_data kind=tpl 返回）。只在出题时取一次；写得越短越省 Claude 用量，Max 会在推题后补等价答案、考点和解析。
export const TEMPLATES = `save({def:{subject,topic}, questions:[…]})。公式 $..$，化学式 $\\ce{..}$；ans 是数组；tag 定题型和画板。
选择 {stem,tag:"选择",opts:["A. …","B. …"],ans:["B"]}（ans 多个=多选）
填空 {stem,tag:"填空",ans:["1"]}：答案唯一才用（网站+Max 判）；多空逗号连 "2,3"
计算/解答 {stem,tag:"计算"|"解答",ans:["要点"],exp:"评分点"}：看过程
证明/作图/函数 tag:"证明"|"作图"|"函数"（方格/坐标板，单位=格）；物理作图 tag:"电路"|"光路"|"受力"
简答/实验/翻译 {stem,tag:"简答",ans:["参考"],exp:"得分点"}；默写用 填空
照片原错题放 wrong 带 upload:照片id；同类题 questions 带 origin:原题id；复习旧题 save({review:[id]})。
topic/exp/等价答案可省，Max 会补；返回有 ⚠ 才核对。推错了撤回：save({retract:["数学3"]}) 或 retract:["last"]（上一批整批）。
排期：每题可带 due:"YYYY-MM-DD"（哪天开始做，省略=今天）；已推的题 save({plan:[{q:["物理3","物理4"],d:"2026-10-14"}]})，q 可写 "last"（刚推的一批），d 写今天=今天做。网站只把到期的题放进今日练习和 Max 的推荐，其余在题库里等着；题库清单的 d 列是排期。
题图 fig（题目需要图时给，网站自动裁边居中画出）：{axes?:坐标系,grid?:方格,x?:[a,b],y?:[a,b],items:[…]}，单位=格，y 向上。
 点先在 P 里定义（省字）：P:{A:[0,3],B:[0,0]}，之后用名字；要标坐标用 {t:"pt",p:[1,2],n:"P",xy:1}。{t:"seg"|"line"|"ray",a:"A",b:"B",d?:虚线,c?:"red"|"blue"}；{t:"poly",pts:"ABC"}；
 {t:"circle",o:"O",r:2}；{t:"fn",expr:"y=x^2-2x"}；{t:"text",p:[1,2],s:"60°"}；{t:"right",at:"C",a:"A",b:"B"} 直角；{t:"angle",at:"B",a:"A",b:"C",s:"α"} 角弧；
 物理 {t:"force"|"light"|"normal"|"mirror"|"lens",a,b,n?}。
电路图 fig:{circuit:true,items:[…]}（格点坐标，y 向下）：元件 {t:"cell"|"batt"|"sw"|"lamp"|"res"|"rheo"|"am"|"vm"|"motor"|"bell"|"led"|"fuse",a:[0,0],b:[2,0],n:"L1",on?:开关闭合}（横放或竖放，两端=接线点，≥2 格）；导线 {t:"wire",pts:[[2,0],[6,0],[6,4]]}（不在一条线上自动折直角，三线交汇自动画连接点）；{t:"text",p,s}。
其它图（实验装置、图表）直接 fig:{svg:"<svg viewBox=…>…</svg>"}。organize 可带 fig 补图。`;
