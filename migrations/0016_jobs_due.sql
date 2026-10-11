-- 新题排期：哪天开始出现在今日练习（YYYY-MM-DD，北京时间；空 = 马上）
ALTER TABLE questions ADD COLUMN due TEXT;
-- 后台任务队列：慢的模型活（整理分类、复核新题、首页建议、错题总结）存在这里，请求里先试跑，没跑完由每分钟的定时任务接着做
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  arg TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',  -- queued / running / done / failed
  runner TEXT,                            -- req = 在网页请求里试跑（平台 30 秒后会切断）/ cron = 定时任务（可以长时间运行）
  tries INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  started TEXT,
  msg TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status, id);
