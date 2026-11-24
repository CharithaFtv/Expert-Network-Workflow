-- Links a queued brief to its vendor so delivery can update project_vendors.status.
ALTER TABLE outbox ADD COLUMN vendor_id INTEGER REFERENCES vendors(id);
