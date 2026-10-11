-- 题图：Claude 推题时用画板描述（JSON：点线圆函数等，单位=格）或直接给 SVG，网站画出来
ALTER TABLE questions ADD COLUMN fig TEXT;
