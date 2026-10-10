-- 题型标签（Claude 给的 tag），网站据此定题型和画板；画板由 tag 推出，不再改 board 列的 CHECK（免得重建表）
ALTER TABLE questions ADD COLUMN tag TEXT;
