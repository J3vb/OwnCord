package db

// AuditEntry represents a single row from the audit_log table joined with the
// actor's username.
type AuditEntry struct {
	ID         int64  `json:"id"`
	ActorID    int64  `json:"actor_id"`
	ActorName  string `json:"actor_name"`
	Action     string `json:"action"`
	TargetType string `json:"target_type"`
	TargetID   int64  `json:"target_id"`
	// TargetName is the target's name as it is now (user, role, channel or
	// category), read when the log is listed; empty once the target is gone.
	// The Detail keeps the name it had at the time (an emoji or sticker row
	// always names it there).
	TargetName string `json:"target_name,omitempty"`
	Detail     string `json:"detail"`
	// SubjectToken is the deletion-marker token of an erased subject the row
	// targeted, set by the erasure on rows that lost their target id and on its
	// own rows. ActorToken is the same for an erased actor, so a row naming two
	// erased subjects keeps both. Both are empty otherwise.
	SubjectToken string `json:"subject_token,omitempty"`
	ActorToken   string `json:"actor_token,omitempty"`
	CreatedAt    string `json:"created_at"`
}
