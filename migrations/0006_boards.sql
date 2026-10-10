-- 画板类型扩展：calc=计算解答板，circuit=物理电路图板（coord/grid=几何函数板不变）；tag=Claude 给的题型标签，网站据此配题型和画板
-- SQLite 不能改 CHECK，只能重建 questions 表
PRAGMA defer_foreign_keys = true;
CREATE TABLE questions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  topic TEXT,
  type TEXT NOT NULL CHECK (type IN ('single','multi','fill','short')),
  stem TEXT NOT NULL,
  options TEXT,
  answer TEXT NOT NULL,
  explanation TEXT,
  source TEXT NOT NULL DEFAULT '同类题' CHECK (source IN ('原错题','同类题')),
  origin_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT,
  board TEXT CHECK (board IS NULL OR board IN ('coord','grid','calc','circuit')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','mastered','done')),
  status_at TEXT,
  tag TEXT
);
INSERT INTO questions_new (id, subject, topic, type, stem, options, answer, explanation, source, origin_id, created_at, category, board, status, status_at)
  SELECT id, subject, topic, type, stem, options, answer, explanation, source, origin_id, created_at, category, board, status, status_at FROM questions;
DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;
CREATE INDEX idx_questions_cat ON questions(subject, category, topic);
CREATE INDEX idx_questions_status ON questions(status, status_at);
