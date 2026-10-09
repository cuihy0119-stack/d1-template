-- 错题生命周期：active 复习中 / mastered 已掌握 / done 同类题一次做对
ALTER TABLE questions ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','mastered','done'));
ALTER TABLE questions ADD COLUMN status_at TEXT; -- 变成 mastered/done 的时间，定时清理用

-- 旧数据补状态：不在复习队列且最后一次做对的题
UPDATE questions SET status = CASE WHEN source = '同类题' AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = questions.id AND a.is_correct = 0) THEN 'done' ELSE 'mastered' END,
  status_at = datetime('now')
WHERE id NOT IN (SELECT question_id FROM review_queue)
  AND (SELECT is_correct FROM attempts a WHERE a.question_id = questions.id ORDER BY a.id DESC LIMIT 1) = 1;
CREATE INDEX idx_questions_status ON questions(status, status_at);

-- attempts 重建：去掉对 questions 的外键（题删了作答仍保留），并冗余 subject、topic 供统计
PRAGMA defer_foreign_keys = true;
CREATE TABLE attempts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  subject TEXT,
  topic TEXT,
  answer_text TEXT,
  photo_key TEXT,
  is_correct INTEGER,
  score REAL,
  comment TEXT,
  error_reason TEXT CHECK (error_reason IS NULL OR error_reason IN ('概念不清','表述不规范','审题失误','计算错误','不会做')),
  status TEXT NOT NULL DEFAULT '已判' CHECK (status IN ('已判','待批改')),
  time_spent_sec INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO attempts_new (id, question_id, subject, topic, answer_text, photo_key, is_correct, score, comment, error_reason, status, time_spent_sec, created_at)
  SELECT a.id, a.question_id, q.subject, q.topic, a.answer_text, a.photo_key, a.is_correct, a.score, a.comment, a.error_reason, a.status, a.time_spent_sec, a.created_at
  FROM attempts a LEFT JOIN questions q ON q.id = a.question_id;
DROP TABLE attempts;
ALTER TABLE attempts_new RENAME TO attempts;
CREATE INDEX idx_attempts_question ON attempts(question_id);
CREATE INDEX idx_attempts_status ON attempts(status);
CREATE INDEX idx_attempts_created ON attempts(created_at);
