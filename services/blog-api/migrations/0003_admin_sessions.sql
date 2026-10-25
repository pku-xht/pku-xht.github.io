-- Only keyed hashes of randomly generated administrator session tokens.
-- Session tokens, passwords and browser/account data are never stored here.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX admin_session_expiry ON admin_sessions(expires_at);
