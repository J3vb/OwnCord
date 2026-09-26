-- B4-10 (Codex review of #1522): migration 041 gave the actor its own token
-- column, but left the rows migration 038 had already unlinked in the old
-- representation, an erased actor's token sitting in subject_token with
-- actor_id = 0. Erasing that row's still-present target would overwrite it,
-- losing the actor linkage 041 exists to keep. The determinable ones move
-- here: where the target is not an erased user, the token can only be the
-- actor's. A row with both sides at 0 keeps its one token on both sides,
-- which is what the self-service account_deleted row means and the best a
-- row that never held the other subject's token can offer. The replay row's
-- actor is the server, never the subject, so its token stays the target's.
UPDATE audit_log SET actor_token = subject_token, subject_token = NULL
 WHERE actor_id = 0 AND subject_token IS NOT NULL AND actor_token IS NULL
   AND NOT (target_type = 'user' AND target_id = 0);

UPDATE audit_log SET actor_token = subject_token
 WHERE actor_id = 0 AND subject_token IS NOT NULL AND actor_token IS NULL
   AND target_type = 'user' AND target_id = 0
   AND action <> 'account_erasure_replayed';
