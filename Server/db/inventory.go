package db

import "context"

// InventoryClass is one row of the subject-inventory queries in
// docs/architecture/data-lifecycle.md: a data class that can hold a user, and the
// COUNT(*) saying whether it still does.
type InventoryClass struct {
	Key   string
	Query string
	Args  func(uid int64, uname string) []any
}

func inventoryByUID(uid int64, _ string) []any     { return []any{uid} }
func inventoryByUname(_ int64, uname string) []any { return []any{uname} }
func inventoryBothIDs(uid int64, _ string) []any   { return []any{uid, uid} }

// SubjectInventory is the data-lifecycle.md class inventory as queries, keyed
// by class number: the checklist account erasure walks afterwards (every count
// must be zero; class 21 counts audit rows still carrying the id, which the
// unlinking takes to zero) and the before/after table the drills paste. uname
// is the username before erasure, for the lockout keys.
var SubjectInventory = []InventoryClass{
	{"1 identity row", `SELECT COUNT(*) FROM users WHERE id = ?`, inventoryByUID},
	{"2 sessions", `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, inventoryByUID},
	{"2a push subscriptions", `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`, inventoryByUID},
	{"3 api tokens", `SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, inventoryByUID},
	{"4a totp secret", `SELECT COUNT(*) FROM users WHERE id = ? AND totp_secret IS NOT NULL`, inventoryByUID},
	{"4b second-factor rows", `SELECT (SELECT COUNT(*) FROM partial_auth_challenges WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM pending_totp_enrollments WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM totp_used_codes WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ?1)`, inventoryByUID},
	{"5 recovery secrets", `SELECT (SELECT COUNT(*) FROM recovery_kits WHERE user_id = ?1)
		+ (SELECT COUNT(*) FROM recovery_assists WHERE user_id = ?1 OR issued_by = ?1)`, inventoryByUID},
	// Exact-suffix match, not LIKE (as in erasureDeleteLockouts), so a `_` or `%` in a
	// username cannot widen onto another key.
	{"6 rate-limit keys", `SELECT COUNT(*) FROM rate_lockouts
		WHERE lower(substr(key, -(length(?1) + 1))) = ':' || lower(?1)
		   OR substr(key, -(length(?2) + 1)) = ':' || ?2`,
		func(uid int64, uname string) []any { return []any{uname, uid} }},
	{"7 login attempts", `SELECT COUNT(*) FROM login_attempts WHERE username = ?`, inventoryByUname},
	{"8a messages attributed", `SELECT COUNT(*) FROM messages WHERE user_id = ?`, inventoryByUID},
	{"8b messages with content", `SELECT COUNT(*) FROM messages WHERE user_id = ? AND content <> ''`, inventoryByUID},
	{"8c message retry receipts", `SELECT COUNT(*) FROM message_delivery_receipts WHERE user_id = ?`, inventoryByUID},
	{"9 mentions naming the subject", `SELECT COUNT(*) FROM message_mentions WHERE mentioned_user_id = ?`, inventoryByUID},
	{"10 reactions", `SELECT COUNT(*) FROM reactions WHERE user_id = ?`, inventoryByUID},
	{"10a poll votes", `SELECT COUNT(*) FROM poll_votes WHERE user_id = ?`, inventoryByUID},
	{"11 read states", `SELECT COUNT(*) FROM read_states WHERE user_id = ?`, inventoryByUID},
	{"11a mention receipts", `SELECT COUNT(*) FROM mention_receipts WHERE user_id = ?`, inventoryByUID},
	{"11b call participation", `SELECT COUNT(*) FROM message_call_participants WHERE user_id = ?`, inventoryByUID},
	{"11c group events naming the subject", `SELECT COUNT(*) FROM message_group_events WHERE target_user_id = ?`, inventoryByUID},
	{"12 attachment rows uploaded", `SELECT COUNT(*) FROM attachments WHERE uploader_id = ?`, inventoryByUID},
	{"12a upload byte counter", `SELECT COUNT(*) FROM user_storage WHERE user_id = ?`, inventoryByUID},
	{"14a dm participation", `SELECT COUNT(*) FROM dm_participants WHERE user_id = ?`, inventoryByUID},
	{"14b dm open state", `SELECT COUNT(*) FROM dm_open_state WHERE user_id = ?`, inventoryByUID},
	{"14e group dm owner", `SELECT COUNT(*) FROM channels WHERE dm_owner_id = ?`, inventoryByUID},
	{"14c message requests", `SELECT COUNT(*) FROM message_requests WHERE sender_id = ? OR recipient_id = ?`, inventoryBothIDs},
	{"14d trusted senders", `SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = ? OR sender_id = ?`, inventoryBothIDs},
	{"15 invites", `SELECT COUNT(*) FROM invites WHERE created_by = ? OR redeemed_by = ?`, inventoryBothIDs},
	// 15b: the redemption survives with user_id NULLed; the class goes to zero on the
	// link, not the row.
	{"15b invite redemptions", `SELECT COUNT(*) FROM invite_redemptions WHERE user_id = ?`, inventoryByUID},
	{"16 emoji", `SELECT COUNT(*) FROM emoji WHERE uploaded_by = ?`, inventoryByUID},
	{"16c stickers", `SELECT COUNT(*) FROM stickers WHERE uploaded_by = ?`, inventoryByUID},
	{"16a private notes", `SELECT COUNT(*) FROM user_notes WHERE owner_id = ? OR target_id = ?`, inventoryBothIDs},
	{"16b dm privacy settings", `SELECT COUNT(*) FROM user_privacy WHERE user_id = ?`, inventoryByUID},
	{"17 blocks", `SELECT COUNT(*) FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?`, inventoryBothIDs},
	{"18 channel user overrides", `SELECT COUNT(*) FROM channel_user_overrides WHERE user_id = ?`, inventoryByUID},
	{"18a nsfw acknowledgements", `SELECT COUNT(*) FROM nsfw_acknowledgements WHERE user_id = ?`, inventoryByUID},
	{"18b gif favorites", `SELECT COUNT(*) FROM gif_favorites WHERE user_id = ?`, inventoryByUID},
	{"18c category user overrides", `SELECT COUNT(*) FROM category_user_overrides WHERE user_id = ?`, inventoryByUID},
	{"18d thread follows", `SELECT COUNT(*) FROM thread_members WHERE user_id = ?`, inventoryByUID},
	{"18e channel password grants", `SELECT COUNT(*) FROM channel_password_grants WHERE user_id = ?`, inventoryByUID},
	{"19 voice state", `SELECT COUNT(*) FROM voice_states WHERE user_id = ?`, inventoryByUID},
	{"20 replay events", `SELECT COUNT(*) FROM events WHERE ` + EventNamesUserPredicate, inventoryByUID},
	{"20a channel retention updated_by", `SELECT COUNT(*) FROM channel_retention WHERE updated_by = ?`, inventoryByUID},
	{"21 audit rows", `SELECT COUNT(*) FROM audit_log WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?)`, inventoryBothIDs},
	{"22a reports about the subject", `SELECT COUNT(*) FROM reports WHERE subject_id = ?`, inventoryByUID},
	{"22b reports by the subject", `SELECT COUNT(*) FROM reports WHERE reporter_id = ?`, inventoryByUID},
	{"22c evidence authored", `SELECT COUNT(*) FROM report_evidence WHERE author_id = ?`, inventoryByUID},
	{"22d report notes authored", `SELECT COUNT(*) FROM report_notes WHERE author_id = ?`, inventoryByUID},
	{"22e report assignments", `SELECT COUNT(*) FROM reports WHERE assignee_id = ?`, inventoryByUID},
	{"22f report events by the subject", `SELECT COUNT(*) FROM report_events WHERE actor_id = ?`, inventoryByUID},
	// Moderation-action classes: 23a counts rows (cascade-deleted with the users row), 23b
	// the principal column.
	{"23a moderation actions on the subject", `SELECT COUNT(*) FROM moderation_actions WHERE target_id = ?`, inventoryByUID},
	{"23b moderation actions by the subject", `SELECT COUNT(*) FROM moderation_actions WHERE actor_id = ? OR lifted_by = ?`, inventoryBothIDs},
	{"24a appeals by the subject", `SELECT COUNT(*) FROM appeals WHERE appellant_id = ?`, inventoryByUID},
	{"24b appeals decided by the subject", `SELECT COUNT(*) FROM appeals WHERE decided_by = ?`, inventoryByUID},
	// 24c: assignee_id has no token column, so it is its own class; a row assigned but not
	// yet decided by the subject is still caught.
	{"24c appeals assigned to the subject", `SELECT COUNT(*) FROM appeals WHERE assignee_id = ?`, inventoryByUID},
}

// InventoryKeptByErasure names the classes an erasure keeps on purpose; empty, as
// audit history stays unlinked.
var InventoryKeptByErasure = map[string]bool{}

// TakeInventory runs SubjectInventory for one subject and returns the count per class key.
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
