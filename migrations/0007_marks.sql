-- 标记的题（临时文件夹）：做题时点「标记」放进来，交卷后 Claude 用 get_data kind=marked 读取解析；24 小时过期
CREATE TABLE IF NOT EXISTS marks (
  question_id INTEGER PRIMARY KEY,
  attempt_id INTEGER,           -- 交卷后关联本次作答（未交卷的标记 Claude 看不到）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
