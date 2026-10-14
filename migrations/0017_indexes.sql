-- 加速题库/错题本/首页的相关子查询（live()、wrongSql() 每行都要查作答）
CREATE INDEX IF NOT EXISTS idx_attempts_q_correct ON attempts(question_id, is_correct);
CREATE INDEX IF NOT EXISTS idx_attempts_q_status ON attempts(question_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_status_grader ON attempts(status, grader);
CREATE INDEX IF NOT EXISTS idx_questions_status_source ON questions(status, source);
