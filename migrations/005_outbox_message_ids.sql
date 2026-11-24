-- Graph sendMail returns no IDs, so mail is sent as create-draft + send-draft. The draft
-- carries the thread identifiers we need to match vendor replies back to the project.
-- (The draft's own id changes when it moves to Sent Items, so it is not stored.)
ALTER TABLE outbox ADD COLUMN conversation_id TEXT;
ALTER TABLE outbox ADD COLUMN internet_message_id TEXT;
CREATE INDEX idx_outbox_conversation ON outbox(conversation_id);
