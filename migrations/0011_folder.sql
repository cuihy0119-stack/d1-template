-- 错题文件夹：错题重做做对 → 先隐藏进文件夹（status = mastered, sent_at 为空），攒满 20 道发给 Claude 整理后清掉
-- 旧数据：留在错题本里「重做已对」、还没发过的题，移进文件夹
UPDATE questions SET status = 'mastered', status_at = datetime('now')
WHERE status = 'active' AND sent_at IS NULL
  AND id NOT IN (SELECT question_id FROM review_queue)
  AND EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = questions.id AND a.is_correct = 0)
  AND (SELECT is_correct FROM attempts a WHERE a.question_id = questions.id ORDER BY a.id DESC LIMIT 1) = 1;
