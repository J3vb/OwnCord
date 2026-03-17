-- Add composite index on channel_overrides for permission lookups.
-- This prevents N+1 query degradation when listing channels with overrides.
CREATE INDEX IF NOT EXISTS idx_channel_overrides_channel_role
    ON channel_overrides(channel_id, role_id);
