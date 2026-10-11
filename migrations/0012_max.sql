-- Max 助手：作答由谁批改（max / maxing 批改中 / NULL=Claude）；Max 回答缓存（同一问题不重复花额度）
ALTER TABLE attempts ADD COLUMN grader TEXT;
CREATE TABLE max_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
