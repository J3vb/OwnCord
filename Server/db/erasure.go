package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ErasureJob is the durable file half of an account erasure: one row per subject with
// the stored_as names of every file the subject owned. The runner removes the files
// after commit and resumes unfinished jobs at startup and on each maintenance tick.
type ErasureJob struct {
	ID           int64
	UserID       int64
	State        string
	Files        []string
	FilesRemoved int
	Attempts     int
	LastError    string
	// ReplayPurged records that the subject's frames were taken out of the replay
	// pipeline after the member_ban broadcast; false keeps the job listed for Resume.
	ReplayPurged bool
}

const (
	ErasureStateDBDone = "db_done"
	ErasureStateDone   = "done"
)

// EraseAccount hard-deletes every data class attributable to userID
// (docs/architecture/data-lifecycle.md, classes 1-20; class 21, the audit history, is
// unlinked) in three short writer transactions: lock, drain in chunks, finish
// (erasure_chunks.go). secure_delete is on and the WAL is truncated after the last
// commit.
// Children go before the users row because messages.user_id, invites.created_by,
// emoji.uploaded_by and stickers.uploaded_by carry no ON DELETE action. Emoji are
// server-wide: reassigned to the oldest remaining admin-class account, else any
// account, else deleted (their files join the job).
// The stored_as names of the subject's attachments (the avatar is one) are captured
// before the rows go and written to erasure_jobs in the same transaction; the returned
// job is the only handle left on the blobs.
// subjectToken is the deletion marker's token: audit rows naming the subject keep
// action, time and order but lose the id (actor_id / target_id become 0, detail
// cleared) and carry the token; empty unlinks without one.
// Returns ErrLastAdmin for the last admin-class account and ErrNotFound for no such user.
func (d *DB) EraseAccount(ctx context.Context, userID int64, subjectToken string) (*ErasureJob, error) {
	return d.eraseAccount(ctx, userID, subjectToken, true)
}

// ReplayEraseAccount is EraseAccount for a deletion-marker replay
// (MarkerStore.ReplayAccounts), without the last-admin guard: the recorded
// erasure already passed it, and a backup from before an admin handover would
// otherwise keep the subject for good. The caller says so when no admin-class
// account remains.
func (d *DB) ReplayEraseAccount(ctx context.Context, userID int64, subjectToken string) (*ErasureJob, error) {
	return d.eraseAccount(ctx, userID, subjectToken, false)
}

// EraseAccountPreflight runs EraseAccount's refusals (user exists, last-admin guard)
// on the reader so a caller can avoid writing a deletion marker for a refused erasure.
// The transaction checks again.
func (d *DB) EraseAccountPreflight(ctx context.Context, userID int64) error {
	tx, err := d.reader.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("EraseAccountPreflight begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	var one int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, userID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("EraseAccountPreflight user %d: %w", userID, ErrNotFound)
		}
		return fmt.Errorf("EraseAccountPreflight fetch user: %w", err)
	}
	return deleteAccountAdminGuard(ctx, tx, userID)
}

// CountAdminClassAccounts counts the accounts the last-admin guard protects: not
// banned, Owner, Admin or Administrator-bit.
func (d *DB) CountAdminClassAccounts(ctx context.Context) (int, error) {
	var n int
	if err := d.reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM users
		  WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role_id IN
		        (SELECT id FROM roles WHERE id IN (?, ?) OR (permissions & ?) != 0))
		    AND `+notBannedClause+underErasureClause,
		permissions.OwnerRoleID, permissions.AdminRoleID, permissions.Administrator).Scan(&n); err != nil {
		return 0, fmt.Errorf("CountAdminClassAccounts: %w", err)
	}
	return n, nil
}

// erasureStatements are the per-class deletes, children before parents: mentions
// first, attachments before messages (the message delete would only SET NULL
// message_id). Statements a users-row CASCADE also covers stay, so the inventory's
// zero is proved.
var erasureStatements = []struct {
	label string
	query string
}{
	{"message_mentions", `DELETE FROM message_mentions WHERE mentioned_user_id = ?`},
	{"user_storage", `DELETE FROM user_storage WHERE user_id = ?`},
	{"attachments", `DELETE FROM attachments WHERE uploader_id = ?1 OR message_id IN (SELECT id FROM messages WHERE user_id = ?1)`},
	{"messages", `DELETE FROM messages WHERE user_id = ?`},
	// Group event rows naming the subject as target (migration 065); they would
	// otherwise survive with a dangling target.
	{"group events naming the subject", `DELETE FROM messages WHERE id IN (SELECT message_id FROM message_group_events WHERE target_user_id = ?)`},
	{"message_call_participants", `DELETE FROM message_call_participants WHERE user_id = ?`},
	{"message_delivery_receipts", `DELETE FROM message_delivery_receipts WHERE user_id = ?`},
	{"reactions", `DELETE FROM reactions WHERE user_id = ?`},
	// Poll votes; counts are recomputed. The version bump comes first in the same
	// transaction so a client that refetches after the votes went takes the new
	// counts on merge.
	{"poll versions", `UPDATE polls SET version = version + 1 WHERE message_id IN (SELECT DISTINCT message_id FROM poll_votes WHERE user_id = ?)`},
	{"poll_votes", `DELETE FROM poll_votes WHERE user_id = ?`},
	{"read_states", `DELETE FROM read_states WHERE user_id = ?`},
	{"mention_receipts", `DELETE FROM mention_receipts WHERE user_id = ?`},
	{"sessions", `DELETE FROM sessions WHERE user_id = ?`},
	{"push_subscriptions", `DELETE FROM push_subscriptions WHERE user_id = ?`},
	{"api_tokens", `DELETE FROM api_tokens WHERE user_id = ?`},
	{"partial_auth_challenges", `DELETE FROM partial_auth_challenges WHERE user_id = ?`},
	{"pending_totp_enrollments", `DELETE FROM pending_totp_enrollments WHERE user_id = ?`},
	{"totp_used_codes", `DELETE FROM totp_used_codes WHERE user_id = ?`},
	{"totp_recovery_codes", `DELETE FROM totp_recovery_codes WHERE user_id = ?`},
	{"recovery_kits", `DELETE FROM recovery_kits WHERE user_id = ?`},
	{"recovery_assists", `DELETE FROM recovery_assists WHERE user_id = ?`},
	{"recovery_assists issuer", `UPDATE recovery_assists SET issued_by = 0 WHERE issued_by = ?`},
	{"voice_states", `DELETE FROM voice_states WHERE user_id = ?`},
	// Retention policy setter: no FK, so the id would outlive the erasure; the
	// policy stays.
	{"channel_retention setter", `UPDATE channel_retention SET updated_by = 0 WHERE updated_by = ?`},
	{"user_notes", `DELETE FROM user_notes WHERE owner_id = ?1 OR target_id = ?1`},
	{"user_privacy", `DELETE FROM user_privacy WHERE user_id = ?1`},
	{"user_blocks", `DELETE FROM user_blocks WHERE blocker_id = ?1 OR blocked_id = ?1`},
	{"channel_user_overrides", `DELETE FROM channel_user_overrides WHERE user_id = ?`},
	{"category_user_overrides", `DELETE FROM category_user_overrides WHERE user_id = ?`},
	{"thread_members", `DELETE FROM thread_members WHERE user_id = ?`},
	// Voice channel password grants (class 18e); explicit even though the
	// users delete cascades them.
	{"channel_password_grants", `DELETE FROM channel_password_grants WHERE user_id = ?`},
	// Message requests and trusted senders (classes 14c, 14d): both name a
	// sender and a recipient. A survivor across the cascade boundary is the
	// silent-pass shape TestEraseAccount_EveryInventoryClassIsZero catches.
	{"message_requests", `DELETE FROM message_requests WHERE sender_id = ?1 OR recipient_id = ?1`},
	{"trusted_senders", `DELETE FROM trusted_senders WHERE recipient_id = ?1 OR sender_id = ?1`},
	{"nsfw_acknowledgements", `DELETE FROM nsfw_acknowledgements WHERE user_id = ?`},
	{"gif_favorites", `DELETE FROM gif_favorites WHERE user_id = ?`},
	{"dm_participants", `DELETE FROM dm_participants WHERE user_id = ?`},
	// Group DM owner: hand the group to its lowest remaining non-banned member
	// (lowestMemberSQL, as a leave does); NULL when none is left.
	{"group DM owner", `UPDATE channels SET dm_owner_id = ` + lowestMemberSQL("channels.id") + ` WHERE dm_owner_id = ?`},
	{"dm_open_state", `DELETE FROM dm_open_state WHERE user_id = ?`},
	{"invites created", `DELETE FROM invites WHERE created_by = ?`},
	{"invites redeemed", `UPDATE invites SET redeemed_by = NULL WHERE redeemed_by = ?`},
	// Invite redemption history: the redemption survives with its invite so the
	// owner keeps the use count, with the user link cut.
	{"invite redemptions", `UPDATE invite_redemptions SET user_id = NULL WHERE user_id = ?`},
	// Replay events naming the subject are not here: the drain walks the table in
	// key windows and the finish stage sweeps only rows written since the lock
	// (eraseSubjectRows); a JSON predicate over every row is the slowest statement.
}

// EventNamesUserPredicate is the SQL deciding whether a persisted replay event
// names a user, bound as ?1. A persisted row is the wire envelope
// `{"seq":...,"type":...,"payload":{...}}` (ws.wrapWithSeq), so every lookup
// goes through $.payload: user_id on state frames, user.id on message frames,
// mentions, call.participants, group_event.target_user_id, from_user_id,
// presence_batch updates[].user_id and member_update_batch members[].user_id.
// ws.eventNamesUser is the same rule over the ring buffer's bytes; the two
// must stay in step.
const EventNamesUserPredicate = `(json_extract(payload, '$.payload.user_id') = ?1
	 OR json_extract(payload, '$.payload.user.id') = ?1
	 OR json_extract(payload, '$.payload.from_user_id') = ?1
	 OR json_extract(payload, '$.payload.referenced_message.user.id') = ?1
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.mentions') WHERE json_each.value = ?1)
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.call.participants') WHERE json_each.value = ?1)
	 OR json_extract(payload, '$.payload.group_event.target_user_id') = ?1
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.updates') WHERE json_extract(json_each.value, '$.user_id') = ?1)
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.members') WHERE json_extract(json_each.value, '$.user_id') = ?1))`

// DeleteEventsForUser removes every persisted replay event naming userID and returns
// rows deleted. It runs again after the member_ban broadcast and persister flush so
// nothing queued after the transaction survives.
func (d *DB) DeleteEventsForUser(ctx context.Context, userID int64) (int64, error) {
	res, err := d.writer.ExecContext(ctx, `DELETE FROM events WHERE `+EventNamesUserPredicate, userID)
	if err != nil {
		return 0, fmt.Errorf("DeleteEventsForUser: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("DeleteEventsForUser RowsAffected: %w", err)
	}
	return n, nil
}

func erasureCollectFiles(ctx context.Context, tx *sql.Tx, userID int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT DISTINCT stored_as FROM attachments
		  WHERE uploader_id = ?1 OR message_id IN (SELECT id FROM messages WHERE user_id = ?1)
		  ORDER BY stored_as`, userID)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount list files: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	files := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("EraseAccount scan file: %w", err)
		}
		files = append(files, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("EraseAccount files rows: %w", err)
	}
	return files, nil
}

// erasureReverseMentionCounts reverses the read_states.mention_count bumps the
// subject's own messages made; otherwise a badge from a vanished message
// survives forever. Inline because DecrementMentionCounts opens its own writer
// transaction. The subquery mirrors that guard: undeleted messages past the
// recipient's last_message_id whose mention_receipts say they counted,
// excluding recipients who blocked the author (mentionEntries never counted
// those). MAX(0, ...) keeps it monotonic.
func erasureReverseMentionCounts(ctx context.Context, tx *sql.Tx, userID int64) error {
	_, err := tx.ExecContext(ctx,
		`UPDATE read_states
		 SET mention_count = MAX(0, mention_count - (
		     SELECT COUNT(*)
		     FROM mention_receipts r
		     JOIN messages m ON m.id = r.message_id
		     WHERE r.user_id = read_states.user_id
		       AND r.channel_id = read_states.channel_id
		       AND m.user_id = ?
		       AND m.deleted = 0
		       AND `+countedReceipt+`
		       AND m.id > read_states.last_message_id
		       AND NOT EXISTS (
		           SELECT 1 FROM user_blocks b
		           WHERE b.blocker_id = read_states.user_id
		             AND b.blocked_id = m.user_id
		       )
		 ))
		 WHERE mention_count > 0`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("EraseAccount mention counts: %w", err)
	}
	return nil
}

// erasureDeleteLockouts removes the subject's rate-lockout keys (class 6),
// matching the exact suffix, not LIKE, so a wildcard in a username cannot widen it.
func erasureDeleteLockouts(ctx context.Context, tx *sql.Tx, userID int64, username string) error {
	id := strconv.FormatInt(userID, 10)
	_, err := tx.ExecContext(ctx,
		`DELETE FROM rate_lockouts
		  WHERE lower(substr(key, -(length(?1) + 1))) = ':' || lower(?1)
		     OR substr(key, -(length(?2) + 1)) = ':' || ?2`,
		username, id)
	if err != nil {
		return fmt.Errorf("EraseAccount rate_lockouts: %w", err)
	}
	return nil
}

// erasureReassignAssets moves the subject's emoji to the oldest admin-class account,
// else the oldest account; with nobody left they are deleted and their files returned.
func erasureReassignAssets(ctx context.Context, tx *sql.Tx, userID int64) ([]string, error) {
	var heir int64
	err := tx.QueryRowContext(ctx,
		`SELECT u.id FROM users u
		  WHERE u.id != ?
		  ORDER BY CASE WHEN EXISTS (
		      SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
		       WHERE ur.user_id = u.id AND (r.id IN (?, ?) OR (r.permissions & ?) != 0)) THEN 0 ELSE 1 END, u.id
		  LIMIT 1`,
		userID, permissions.OwnerRoleID, permissions.AdminRoleID, permissions.Administrator,
	).Scan(&heir)
	switch {
	case err == nil:
		if _, err := tx.ExecContext(ctx, `UPDATE emoji SET uploaded_by = ? WHERE uploaded_by = ?`, heir, userID); err != nil {
			return nil, fmt.Errorf("EraseAccount reassign emoji: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE stickers SET uploaded_by = ? WHERE uploaded_by = ?`, heir, userID); err != nil {
			return nil, fmt.Errorf("EraseAccount reassign stickers: %w", err)
		}
		return nil, nil
	case errors.Is(err, sql.ErrNoRows):
		var files []string
		for _, table := range []string{"emoji", "stickers"} {
			removed, err := erasureDeleteAssetRows(ctx, tx, table, userID)
			if err != nil {
				return nil, err
			}
			files = append(files, removed...)
		}
		return files, nil
	default:
		return nil, fmt.Errorf("EraseAccount asset heir: %w", err)
	}
}

func erasureDeleteAssetRows(ctx context.Context, tx *sql.Tx, table string, userID int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `DELETE FROM `+table+` WHERE uploaded_by = ? RETURNING filename`, userID) //nolint:gosec
	if err != nil {
		return nil, fmt.Errorf("EraseAccount delete %s: %w", table, err)
	}
	defer rows.Close() //nolint:errcheck
	var files []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("EraseAccount scan %s: %w", table, err)
		}
		files = append(files, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("EraseAccount %s rows: %w", table, err)
	}
	return files, nil
}

func referencedStoredFilesSQL(n int) string {
	in := strings.TrimSuffix(strings.Repeat("?,", n), ",")
	return `SELECT stored_as FROM attachments WHERE stored_as IN (` + in + `)` + //nolint:gosec
		` UNION SELECT filename FROM emoji WHERE filename IN (` + in + `)` +
		` UNION SELECT filename FROM stickers WHERE filename IN (` + in + `)`
}

// ReferencedStoredFiles reports which of names are still referenced by a row, for
// storage reconciliation.
func (d *DB) ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error) {
	referenced := make(map[string]bool, len(names))
	const chunk = 200
	for start := 0; start < len(names); start += chunk {
		end := min(start+chunk, len(names))
		batch := names[start:end]
		args := make([]any, 0, len(batch))
		for _, n := range batch {
			args = append(args, n)
		}
		query := referencedStoredFilesSQL(len(batch))
		all := make([]any, 0, 3*len(args))
		all = append(all, args...)
		all = append(all, args...)
		all = append(all, args...)
		rows, err := d.reader.QueryContext(ctx, query, all...)
		if err != nil {
			return nil, fmt.Errorf("ReferencedStoredFiles: %w", err)
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close() //nolint:errcheck
				return nil, fmt.Errorf("ReferencedStoredFiles scan: %w", err)
			}
			referenced[name] = true
		}
		rows.Close() //nolint:errcheck
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("ReferencedStoredFiles rows: %w", err)
		}
	}
	return referenced, nil
}
