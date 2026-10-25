ALTER TABLE comments ADD COLUMN body_html TEXT;
ALTER TABLE comments ADD COLUMN author_url TEXT NOT NULL DEFAULT '';

-- The payload exists only during this one INSERT and its trigger transaction.
-- Keep import hashes/IDs after moderation/deletion so reruns cannot revive them.
CREATE TABLE comment_import_batches (
  batch_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload))
);
CREATE TABLE comment_import_ids (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES comment_import_batches(batch_id),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64)
);

CREATE TRIGGER import_public_comments AFTER INSERT ON comment_import_batches
WHEN NEW.payload IS NOT NULL BEGIN
  INSERT INTO comments(id, document, nickname, body, body_html, author_url,
    parent_id, status, request_id, request_hash, created_at, moderated_at)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.document'),
    json_extract(value, '$.nickname'), json_extract(value, '$.body'),
    json_extract(value, '$.body_html'), json_extract(value, '$.author_url'),
    json_extract(value, '$.parent_id'), 'approved',
    'import:' || json_extract(value, '$.id'), json_extract(value, '$.content_hash'),
    json_extract(value, '$.created_at'), NEW.imported_at
  FROM json_each(NEW.payload)
  WHERE NOT EXISTS (SELECT 1 FROM comment_import_ids previous
    WHERE previous.id = json_extract(value, '$.id'));

  INSERT INTO comment_import_ids(id, batch_id, content_hash)
  SELECT json_extract(value, '$.id'), NEW.batch_id,
    json_extract(value, '$.content_hash') FROM json_each(NEW.payload) WHERE true
  ON CONFLICT(id) DO UPDATE SET content_hash = CASE
    WHEN comment_import_ids.content_hash = excluded.content_hash
    THEN comment_import_ids.content_hash ELSE NULL END;

  UPDATE comment_import_batches SET payload = NULL WHERE batch_id = NEW.batch_id;
END;
