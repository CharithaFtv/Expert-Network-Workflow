-- Sending is claim-then-send: a row is marked Sending (with claimed_at) before the network
-- call and resolved afterwards, so a crash can never cause a second delivery.
ALTER TABLE outbox ADD COLUMN claimed_at TEXT;
-- Rows queued before the sender existed were never meant to be delivered.
UPDATE outbox SET status = 'Skipped', last_error = 'Queued before the sender existed; not sent'
 WHERE status = 'Queued';
