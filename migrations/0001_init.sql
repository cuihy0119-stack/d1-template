CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待处理' CHECK (status IN ('待处理','已处理')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  topic TEXT,
  type TEXT NOT NULL CHECK (type IN ('single','multi','fill','short')),
  stem TEXT NOT NULL,
  options TEXT,            -- JSON 数组
  answer TEXT NOT NULL,    -- JSON 数组（选择题=选项字母；填空题=可接受答案；简答题=[参考答案]）
  explanation TEXT,
  source TEXT NOT NULL DEFAULT '同类题' CHECK (source IN ('原错题','同类题')),
  origin_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer_text TEXT,
  photo_key TEXT,          -- 多张用英文逗号分隔
  is_correct INTEGER,      -- 1/0，待批改时为 NULL
  score REAL,
  comment TEXT,
  error_reason TEXT CHECK (error_reason IS NULL OR error_reason IN ('概念不清','表述不规范','审题失误','计算错误','不会做')),
  status TEXT NOT NULL DEFAULT '已判' CHECK (status IN ('已判','待批改')),
  time_spent_sec INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE review_queue (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id),
  next_date TEXT NOT NULL, -- YYYY-MM-DD（北京时间）
  stage INTEGER NOT NULL DEFAULT 0  -- 0..4 对应间隔 1、2、4、7、15 天
);

CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_attempts_question ON attempts(question_id);
CREATE INDEX idx_attempts_status ON attempts(status);
CREATE INDEX idx_attempts_created ON attempts(created_at);
CREATE INDEX idx_review_next ON review_queue(next_date);
CREATE INDEX idx_uploads_status ON uploads(status);
