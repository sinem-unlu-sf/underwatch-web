-- Local accounts (email + password) and their sessions. Only a scrypt hash of each password and the sha256 of each
-- session token are stored; neither is ever returned by the API.
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX idx_sessions_account ON sessions(account_id);
