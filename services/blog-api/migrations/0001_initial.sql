PRAGMA foreign_keys = ON;

CREATE TABLE public_documents (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND id NOT GLOB '*[^0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'page'))
);

-- Only original public comment IDs and their public document are needed here.
CREATE TABLE legacy_parents (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wp-[0-9]*'),
  document TEXT NOT NULL REFERENCES public_documents(id)
);

CREATE TABLE comments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  document TEXT NOT NULL REFERENCES public_documents(id),
  nickname TEXT NOT NULL CHECK (length(trim(nickname)) BETWEEN 1 AND 40),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  moderated_at TEXT
);
CREATE INDEX comments_public ON comments(document, status, seq);
CREATE INDEX comments_moderation ON comments(status, seq);
CREATE INDEX comments_parent ON comments(parent_id, document);

-- Salted address hashes live only in short-lived rate buckets, never comments.
CREATE TABLE rate_buckets (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_expiry ON rate_buckets(expires_at);

CREATE TABLE visit_baselines (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  batch_id TEXT NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL,
  site_base INTEGER NOT NULL CHECK (site_base >= 0),
  captured_at TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE document_baselines (
  document TEXT PRIMARY KEY REFERENCES public_documents(id),
  base INTEGER NOT NULL CHECK (base >= 0)
);
CREATE TABLE visit_deltas (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count >= 0)
);
CREATE TABLE visit_events (
  nonce TEXT PRIMARY KEY,
  document TEXT REFERENCES public_documents(id),
  created_at TEXT NOT NULL
);

-- An event and both increments are one SQLite statement/transaction. Replayed
-- nonces do not insert, so they cannot increment either counter a second time.
CREATE TRIGGER increment_visit AFTER INSERT ON visit_events BEGIN
  INSERT INTO visit_deltas(key, count) VALUES ('site', 1)
    ON CONFLICT(key) DO UPDATE SET count = count + 1;
  INSERT INTO visit_deltas(key, count)
    SELECT 'document:' || NEW.document, 1 WHERE NEW.document IS NOT NULL
    ON CONFLICT(key) DO UPDATE SET count = count + 1;
END;
