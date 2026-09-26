-- B4-10 draft: unlinkable integrity history (BPR-053).
-- Audit rows keep their action, time and ordering after an erasure but stop
-- naming the subject: actor_id / target_id become 0 and subject_token holds
-- the marker token, so "an erasure happened, by this actor class, at this
-- time" survives while "of whom" needs the marker key. Free-text detail is
-- rewritten by the erasure (usernames and ids removed) — the schema only has
-- to give the token a column.
ALTER TABLE audit_log ADD COLUMN subject_token TEXT;
CREATE INDEX idx_audit_log_subject_token ON audit_log(subject_token) WHERE subject_token IS NOT NULL;
