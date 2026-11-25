-- sender_note: why a sender was not verified (shown to the reviewer in 3f).
ALTER TABLE inbound_messages ADD COLUMN sender_note TEXT;

-- A message whose attachments keep failing (for example it was deleted from the mailbox) must not block
-- newer messages. Each failed run counts; after a few tries the message is left alone and reported.
ALTER TABLE inbound_messages
  ADD COLUMN attachments_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN attachments_error TEXT;
