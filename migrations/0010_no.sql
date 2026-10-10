-- 题号：每科各自从 1 编号，显示成「数学1：题干」。旧题按录入先后补号
ALTER TABLE questions ADD COLUMN no INTEGER;
UPDATE questions SET no = (SELECT COUNT(*) FROM questions q2 WHERE q2.subject = questions.subject AND q2.id <= questions.id);
