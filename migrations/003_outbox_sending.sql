-- Outbox becomes a sendable queue: Queued -> Sent | Failed (after retries).
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_error TEXT;
ALTER TABLE outbox ADD COLUMN sent_at TEXT;
CREATE INDEX idx_outbox_status ON outbox(status, id);
