-- Make the periodic session-expiry sweep sargable. The sweep used to run
-- strftime over every row on the single writer connection every 15 minutes.
-- The server writes expires_at as RFC3339 UTC ("2006-01-02T15:04:05Z") --
-- normalize any legacy space-separated rows to that layout so plain text
-- comparison is correct, then index the column.

UPDATE sessions SET expires_at = replace(expires_at, ' ', 'T')
 WHERE instr(expires_at, ' ') > 0;

UPDATE sessions SET expires_at = expires_at || 'Z'
 WHERE length(expires_at) = 19;

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
