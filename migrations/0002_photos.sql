-- 照片存 D1（base64），不依赖 R2。key 沿用 uploads.r2_key / attempts.photo_key
CREATE TABLE photos (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
