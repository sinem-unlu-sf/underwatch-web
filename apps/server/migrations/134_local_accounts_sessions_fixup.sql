-- Repairs databases that applied an early draft of 133_local_accounts, which created `account_sessions` instead of
-- `sessions`. On a database that ran the final 133 this is a no-op. The draft table held no usable sessions (login never
-- succeeded against it), so it is dropped.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

DROP TABLE IF EXISTS account_sessions;
