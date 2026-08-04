CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  follow_up TEXT,
  context_json TEXT,
  client_created_at TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX feedback_received_at_idx ON feedback(received_at);
CREATE INDEX feedback_expires_at_idx ON feedback(expires_at);
