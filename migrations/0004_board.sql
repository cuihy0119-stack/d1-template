-- 作图题：coord=坐标系（画函数图像），grid=方格纸（画几何图形）；NULL=不需要作图
ALTER TABLE questions ADD COLUMN board TEXT CHECK (board IS NULL OR board IN ('coord','grid'));
