-- 章节/知识库分类（由 Claude 整理，与其 Notion 错题库保持一致）
ALTER TABLE questions ADD COLUMN category TEXT;
CREATE INDEX idx_questions_cat ON questions(subject, category, topic);
