-- Max 接管错题本：每道错题的 Max 错因 + 一句话诊断（max_at = 整理时间，之后又错了会重新整理）
ALTER TABLE questions ADD COLUMN max_reason TEXT;
ALTER TABLE questions ADD COLUMN max_note TEXT;
ALTER TABLE questions ADD COLUMN max_at TEXT;
