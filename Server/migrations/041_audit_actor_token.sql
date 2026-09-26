-- B4-10 (Codex review of #1520): an audit row names two principals, the
-- actor and the target, and the audit_unlinking draft (migration 038) gave
-- the erasure one token column. Erasing the second principal overwrote the
-- first's token, so a row about two erased subjects stayed linkable to one
-- of them only. The actor's token gets its own column and subject_token
-- stays the target's, so such a row keeps both.
ALTER TABLE audit_log ADD COLUMN actor_token TEXT;
CREATE INDEX idx_audit_log_actor_token ON audit_log(actor_token) WHERE actor_token IS NOT NULL;
