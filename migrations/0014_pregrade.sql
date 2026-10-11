-- Max 给交给 Claude 的题（作图/电路等）写初评：Claude 同意就 save({ok:[id]})，不用自己写评语，看得也少
ALTER TABLE attempts ADD COLUMN max_score REAL;
ALTER TABLE attempts ADD COLUMN max_comment TEXT;
ALTER TABLE attempts ADD COLUMN max_sure REAL;
