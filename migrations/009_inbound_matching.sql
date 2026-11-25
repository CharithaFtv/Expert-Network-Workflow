-- Step 3b: match each received message to a project and check who sent it.
--
-- vendors.domains: extra sender domains a vendor may reply from. The domain of intake_email always
-- counts too, so this is only needed when replies come from another domain.
ALTER TABLE vendors ADD COLUMN domains TEXT[] NOT NULL DEFAULT '{}';

-- status flow: Received -> Matched | Unverified | Unmatched
--   Matched    project found and the sender's domain belongs to an active vendor on the vendor list
--   Unverified project found but the sender's domain is not a known vendor domain (never reaches the model)
--   Unmatched  no project found; a person assigns it
ALTER TABLE inbound_messages
  ADD COLUMN project_id INTEGER REFERENCES projects(id),
  ADD COLUMN vendor_id INTEGER REFERENCES vendors(id),
  ADD COLUMN match_method TEXT,
  ADD COLUMN sender_verified BOOLEAN,
  ADD COLUMN matched_at TEXT,
  ADD CONSTRAINT inbound_status_check CHECK (status IN ('Received', 'Matched', 'Unverified', 'Unmatched')),
  ADD CONSTRAINT inbound_method_check CHECK (match_method IN ('subject_code', 'conversation', 'header', 'manual'));
CREATE INDEX idx_inbound_project ON inbound_messages(project_id);
