package db

import "context"

// InventoryClass is one row of the subject-inventory queries in
// docs/architecture/data-lifecycle.md (appendix): a data class that can hold
// a user, and the COUNT(*) that says whether it still does.
type InventoryClass struct {
	Key   string
	Query string
	Args  func(uid int64, uname string) []any
}

func inventoryByUID(uid int64, _ string) []any     { return []any{uid} }
func inventoryByUname(_ int64, uname string) []any { return []any{uname} }
func inventoryBothIDs(uid int64, _ string) []any   { return []any{uid, uid} }

// SubjectInventory is the data-class inventory of data-lifecycle.md as
// queries, keyed by class number. It is the generated lineage checklist B4-9
// walks after an erasure (every count must be zero; class 21 counts audit
// rows that still carry the id, which B4-10's unlinking takes to zero while
// the rows themselves stay) and the before/after table the HP-4 drills
// paste. uname is the username before erasure, for the lockout keys.
var SubjectInventory = []InventoryClass{
	{"1 identity row", `SELECT COUNT(*) FROM users WHERE id = ?`, inventoryByUID},
	{"2 sessions", `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, inventoryByUID},
	{"3 api tokens", `SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, inventoryByUID},
	{"4a totp secret", `SELECT COUNT(*) FROM users WHERE id = ? AND totp_secret IS NOT NULL`, inventoryByUID},
	{"4b second-factor rows", `SELECT (SELECT COUNT(*) FROM partial_auth_challenges WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM pending_totp_enrollments WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM totp_used_codes WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ?1)`, inventoryByUID},
	{"5 recovery secrets", `SELECT (SELECT COUNT(*) FROM recovery_kits WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM recovery_assists WHERE user_id = ?1 OR issued_by = ?1)`, inventoryByUID},
	{"6 rate-limit keys", `SELECT COUNT(*) FROM rate_lockouts WHERE key LIKE '%:' || ? OR key LIKE '%:' || ?`,
		func(uid int64, uname string) []any { return []any{uname, uid} }},
	{"7 login attempts", `SELECT COUNT(*) FROM login_attempts WHERE username = ?`, inventoryByUname},
	{"8a messages attributed", `SELECT COUNT(*) FROM messages WHERE user_id = ?`, inventoryByUID},
	{"8b messages with content", `SELECT COUNT(*) FROM messages WHERE user_id = ? AND content <> ''`, inventoryByUID},
	{"9 mentions naming the subject", `SELECT COUNT(*) FROM message_mentions WHERE mentioned_user_id = ?`, inventoryByUID},
	{"10 reactions", `SELECT COUNT(*) FROM reactions WHERE user_id = ?`, inventoryByUID},
	{"11 read states", `SELECT COUNT(*) FROM read_states WHERE user_id = ?`, inventoryByUID},
	{"12 attachment rows uploaded", `SELECT COUNT(*) FROM attachments WHERE uploader_id = ?`, inventoryByUID},
	{"12a upload byte counter", `SELECT COUNT(*) FROM user_storage WHERE user_id = ?`, inventoryByUID},
	{"14a dm participation", `SELECT COUNT(*) FROM dm_participants WHERE user_id = ?`, inventoryByUID},
	{"14b dm open state", `SELECT COUNT(*) FROM dm_open_state WHERE user_id = ?`, inventoryByUID},
	{"15 invites", `SELECT COUNT(*) FROM invites WHERE created_by = ? OR redeemed_by = ?`, inventoryBothIDs},
	{"16 emoji", `SELECT COUNT(*) FROM emoji WHERE uploaded_by = ?`, inventoryByUID},
	{"17 blocks", `SELECT COUNT(*) FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?`, inventoryBothIDs},
	{"18 channel user overrides", `SELECT COUNT(*) FROM channel_user_overrides WHERE user_id = ?`, inventoryByUID},
	{"19 voice state", `SELECT COUNT(*) FROM voice_states WHERE user_id = ?`, inventoryByUID},
	{"20 replay events", `SELECT COUNT(*) FROM events WHERE ` + EventNamesUserPredicate, inventoryByUID},
	{"20a channel retention updated_by", `SELECT COUNT(*) FROM channel_retention WHERE updated_by = ?`, inventoryByUID},
	{"21 audit rows", `SELECT COUNT(*) FROM audit_log WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?)`, inventoryBothIDs},
	// B5-8 report classes: 22a and 22b count the principal COLUMNS, not the
	// rows — the rows survive erasure by design (decision 7), so the class
	// goes to zero when subject_id/reporter_id are rewritten to 0, exactly
	// like every other bare-id-plus-token class in this file.
	{"22a reports about the subject", `SELECT COUNT(*) FROM reports WHERE subject_id = ?`, inventoryByUID},
	{"22b reports by the subject", `SELECT COUNT(*) FROM reports WHERE reporter_id = ?`, inventoryByUID},
	{"22c evidence authored", `SELECT COUNT(*) FROM report_evidence WHERE author_id = ?`, inventoryByUID},
	{"22d report notes authored", `SELECT COUNT(*) FROM report_notes WHERE author_id = ?`, inventoryByUID},
	{"22e report assignments", `SELECT COUNT(*) FROM reports WHERE assignee_id = ?`, inventoryByUID},
	// 22f (second Codex review): report_events is metadata, not content —
	// unlinking the actor is the whole job, the audit_log shape.
	{"22f report events by the subject", `SELECT COUNT(*) FROM report_events WHERE actor_id = ?`, inventoryByUID},
	// B5-9 moderation-action classes: 23a counts ROWS (they cascade-delete
	// with the users row, unlike a report's outcome — S6 says a warning or
	// timeout is deleted, not kept), 23b counts the principal COLUMN, the
	// same bare-id-plus-token shape as every actor class above.
	{"23a moderation actions on the subject", `SELECT COUNT(*) FROM moderation_actions WHERE target_id = ?`, inventoryByUID},
	{"23b moderation actions by the subject", `SELECT COUNT(*) FROM moderation_actions WHERE actor_id = ? OR lifted_by = ?`, inventoryBothIDs},
	// B5-10 appeal classes: 24a counts ROWS (appellant_id cascades with the
	// users row — S6-d says an appeal is deleted for the appellant, not
	// kept), 24b counts the principal COLUMN, the same bare-id-plus-token
	// shape as every actor class above.
	{"24a appeals by the subject", `SELECT COUNT(*) FROM appeals WHERE appellant_id = ?`, inventoryByUID},
	{"24b appeals decided by the subject", `SELECT COUNT(*) FROM appeals WHERE decided_by = ?`, inventoryByUID},
}

// InventoryKeptByErasure names the classes an erasure leaves on purpose.
// Empty since B4-10: the audit history stays, but unlinked, so no class
// still counts the subject.
var InventoryKeptByErasure = map[string]bool{}

// TakeInventory runs SubjectInventory for one subject and returns the count
// per class key.
func (d *DB) TakeInventory(ctx context.Context, uid int64, uname string) (map[string]int, error) {
	out := make(map[string]int, len(SubjectInventory))
	for _, c := range SubjectInventory {
		var n int
		if err := d.reader.QueryRowContext(ctx, c.Query, c.Args(uid, uname)...).Scan(&n); err != nil {
			return nil, err
		}
		out[c.Key] = n
	}
	return out, nil
}
