// 出题模板（get_data kind=tpl 返回）。只在出题时取一次；写得越短越省 Claude 用量，Max 会在推题后补等价答案、考点和解析。
export const TEMPLATES = `save({def:{subject,topic}, questions:[…]})。公式 $..$，化学式 $\\ce{..}$；ans 是数组；tag 定题型和画板。
选择 {stem,tag:"选择",opts:["A. …","B. …"],ans:["B"]}（ans 多个=多选）
填空 {stem,tag:"填空",ans:["1"]}：答案唯一才用（网站+Max 判）；多空逗号连 "2,3"
计算/解答 {stem,tag:"计算"|"解答",ans:["要点"],exp:"评分点"}：看过程
证明/作图/函数 tag:"证明"|"作图"|"函数"（方格/坐标板，单位=格）；物理作图 tag:"电路"|"光路"|"受力"
简答/实验/翻译 {stem,tag:"简答",ans:["参考"],exp:"得分点"}；默写用 填空
照片原错题放 wrong 带 upload:照片id；同类题 questions 带 origin:原题id；复习旧题 save({review:[id]})。
topic/exp/等价答案可省，Max 会补；返回有 ⚠ 才核对。`;
