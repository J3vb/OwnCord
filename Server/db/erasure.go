package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ErasureJob is the durable file half of an account erasure (migration 037):
// one row per subject, written inside the erasure transaction with the
// stored_as names of every file the subject owned. The runner removes the
// files after commit and marks the job done; unfinished jobs are resumed at
// startup and on every maintenance tick (service.ErasureService).
type ErasureJob struct {
	ID           int64
	UserID       int64
	State        string
	Files        []string
	FilesRemoved int
	Attempts     int
	LastError    string
	// ReplayPurged records that the subject's frames were taken out of the
	// replay pipeline after the member_ban broadcast; false keeps the job
	// listed for Resume even once its files are gone.
	ReplayPurged bool
}

// Erasure job states.
const (
	ErasureStateDBDone = "db_done"
	ErasureStateDone   = "done"
)

// EraseAccount hard-deletes every data class attributable to userID
// (docs/architecture/data-lifecycle.md, classes 1–20; class 21, the audit
// history, is unlinked rather than deleted) in three stages on the writer connection — lock, drain
// in chunks, finish (erasure_chunks.go) — each a short transaction with
// PRAGMA secure_delete on, so the erased rows' bytes do not survive in freed
// pages, and truncates the WAL after the last commit. The last-admin guard and the mention-count
// reversal are kept from the anonymising deletion this replaces.
//
// Children are deleted before the users row: messages.user_id,
// invites.created_by, emoji.uploaded_by and stickers.uploaded_by carry no ON DELETE action,
// so with foreign_keys=ON the users DELETE passes only once they are gone.
// The subject's invites are deleted (an unused code stops working, and who
// invited whom is what the erasure removes); invites the subject redeemed
// keep their row with redeemed_by cleared; emoji are server-wide assets and
// are reassigned to the oldest remaining admin-class account, or to any
// remaining account, or deleted (their files join the job) when the subject
// was the only account.
//
// The stored_as names of the subject's attachments (the avatar is one) are
// captured before the rows go and written to erasure_jobs in the same
// transaction: the returned job is the only handle left on the blobs, and
// the caller removes them (a missing file counts as removed).
//
// subjectToken is the deletion marker's token for the subject: the
// audit rows the subject appears in keep their action, time and order but
// lose the id — actor_id / target_id become 0, detail is cleared — and carry
// the token instead. An empty token unlinks the rows without one.
//
// Returns ErrLastAdmin when the subject is the last admin-class account and
// ErrNotFound when no such user exists. Nothing is logged here by username.
func (d *DB) EraseAccount(ctx context.Context, userID int64, subjectToken string) (*ErasureJob, error) {
	return d.eraseAccount(ctx, userID, subjectToken, true)
}

// ReplayEraseAccount is EraseAccount for a deletion-marker replay
// (MarkerStore.ReplayAccounts): the same transaction without the last-admin
// guard. The guard is a live-operation rule — an administrator may not
// delete the last administrator — and the erasure a marker records passed
// it when it ran; at replay the subject is present only because a backup
// from before the erasure was restored, and a backup from before the admin
// handover would otherwise keep the subject for good. The caller says so
// when no admin-class account remains (service.ErasureService).
func (d *DB) ReplayEraseAccount(ctx context.Context, userID int64, subjectToken string) (*ErasureJob, error) {
	return d.eraseAccount(ctx, userID, subjectToken, false)
}

// EraseAccountPreflight runs EraseAccount's refusals — the user exists, the
// last-admin guard — outside the transaction, on the reader, so a caller
// can write the deletion marker before the transaction without
// writing one for an erasure that would be refused: a pending marker is
// applied on the next open whether or not the transaction ran. The
// transaction checks again; this only closes the window.
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

// CountAdminClassAccounts counts the accounts the last-admin guard would
// protect: not banned, holding the seeded Owner or Admin role or a custom
// role with the Administrator bit — deleteAccountAdminGuard's criteria.
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

// erasureStatements are the per-class deletes, children before parents, all
// bound to the subject's id once. Mentions naming the subject go first
// (CASCADE would take them with the users row, but that row goes last);
// attachments before messages, because the message delete would only SET
// NULL their message_id (migration 030) and the rows are class 12.
var erasureStatements = []struct {
	label string
	query string
}{
	{"message_mentions", `DELETE FROM message_mentions WHERE mentioned_user_id = ?`},
	// The upload byte counter (migration 044, class 12a): a counter
	// keyed by user_id that survived would be a residue naming the subject.
	// The users delete below would cascade it too; this is the explicit
	// statement the inventory's zero is proved against.
	{"user_storage", `DELETE FROM user_storage WHERE user_id = ?`},
	{"attachments", `DELETE FROM attachments WHERE uploader_id = ?1 OR message_id IN (SELECT id FROM messages WHERE user_id = ?1)`},
	// The messages_ad trigger (migration 001) drops each row from the FTS
	// index; message_mentions and reactions on these rows cascade.
	{"messages", `DELETE FROM messages WHERE user_id = ?`},
	// Group event rows naming the subject (migration 065). A row the
	// subject authored went with the statement above. A row another member
	// authored that names the subject as its target (added, removed) would
	// survive the users delete below as a message with a dangling target.
	{"group events naming the subject", `DELETE FROM messages WHERE id IN (SELECT message_id FROM message_group_events WHERE target_user_id = ?)`},
	// Call log participation (migration 064). Call rows the subject authored cascade with messages.
	{"message_call_participants", `DELETE FROM message_call_participants WHERE user_id = ?`},
	{"message_delivery_receipts", `DELETE FROM message_delivery_receipts WHERE user_id = ?`},
	{"reactions", `DELETE FROM reactions WHERE user_id = ?`},
	// Poll votes (migration 073). Votes on polls the subject authored
	// went with those messages above. Counts are always recomputed, so the
	// polls the subject voted in read exactly on the next update or read.
	// The version bump comes first, in the same transaction, so a client that
	// refetches after the votes went reads counts that are newer than any copy
	// it holds, and a merge that keeps the higher version takes them.
	{"poll versions", `UPDATE polls SET version = version + 1 WHERE message_id IN (SELECT DISTINCT message_id FROM poll_votes WHERE user_id = ?)`},
	{"poll_votes", `DELETE FROM poll_votes WHERE user_id = ?`},
	{"read_states", `DELETE FROM read_states WHERE user_id = ?`},
	// Mention ledger (migration 063): receipts naming the subject as the
	// recipient. Receipts for the subject's own messages go with those messages
	// through the cascade above.
	{"mention_receipts", `DELETE FROM mention_receipts WHERE user_id = ?`},
	{"sessions", `DELETE FROM sessions WHERE user_id = ?`},
	// Web Push subscriptions (migration 045, class 2a): the users
	// delete below would cascade this too, but a surviving endpoint is a
	// live channel to a person who left, so it gets its own explicit
	// statement the inventory's zero is proved against.
	{"push_subscriptions", `DELETE FROM push_subscriptions WHERE user_id = ?`},
	{"api_tokens", `DELETE FROM api_tokens WHERE user_id = ?`},
	{"partial_auth_challenges", `DELETE FROM partial_auth_challenges WHERE user_id = ?`},
	{"pending_totp_enrollments", `DELETE FROM pending_totp_enrollments WHERE user_id = ?`},
	{"totp_used_codes", `DELETE FROM totp_used_codes WHERE user_id = ?`},
	{"totp_recovery_codes", `DELETE FROM totp_recovery_codes WHERE user_id = ?`},
	{"recovery_kits", `DELETE FROM recovery_kits WHERE user_id = ?`},
	{"recovery_assists", `DELETE FROM recovery_assists WHERE user_id = ?`},
	// Credentials the subject issued to others stay valid; the issuer link
	// becomes the system actor, as audit rows do.
	{"recovery_assists issuer", `UPDATE recovery_assists SET issued_by = 0 WHERE issued_by = ?`},
	{"voice_states", `DELETE FROM voice_states WHERE user_id = ?`},
	// Retention policy setter (migration 039): no FK, so the id
	// otherwise outlives the erasure. The policy stays in effect — only the
	// link to who set it is cut, as with the recovery_assists issuer above.
	{"channel_retention setter", `UPDATE channel_retention SET updated_by = 0 WHERE updated_by = ?`},
	// Private profile notes (migration 069, class 16a): notes the subject keeps
	// and notes others keep about the subject. The users delete below would
	// cascade both, but this is the explicit statement the inventory's zero is
	// proved against.
	{"user_notes", `DELETE FROM user_notes WHERE owner_id = ?1 OR target_id = ?1`},
	// DM privacy settings (migration 070, class 16b): one row per user, keyed
	// by the owner. The users delete below would cascade it, but this is the
	// explicit statement the inventory's zero is proved against.
	{"user_privacy", `DELETE FROM user_privacy WHERE user_id = ?1`},
	{"user_blocks", `DELETE FROM user_blocks WHERE blocker_id = ?1 OR blocked_id = ?1`},
	{"channel_user_overrides", `DELETE FROM channel_user_overrides WHERE user_id = ?`},
	// Category permission templates (migration 076, class 18c): the per-member
	// rows of a category's template. The users delete below would cascade them,
	// but this is the explicit statement the inventory's zero is proved against.
	{"category_user_overrides", `DELETE FROM category_user_overrides WHERE user_id = ?`},
	// Thread follows (migration 079, class 18d): the subject's membership rows.
	// The users delete below would cascade them, but this is the explicit
	// statement the inventory's zero is proved against.
	{"thread_members", `DELETE FROM thread_members WHERE user_id = ?`},
	// Voice channel password grants (migration 086, class 18e): which channels
	// the subject has entered the password of. The users delete below would
	// cascade them, but this is the explicit statement the inventory's zero is
	// proved against.
	{"channel_password_grants", `DELETE FROM channel_password_grants WHERE user_id = ?`},
	// Message requests and trusted senders (migration 046, classes 14c
	// and 14d): both tables name a sender and a recipient, so an erasure of
	// either party needs both columns — the users delete below would cascade
	// these too, but a surviving row across the cascade boundary is exactly
	// the silent-pass shape TestEraseAccount_EveryInventoryClassIsZero exists
	// to catch, so they get their own explicit statements before it runs.
	{"message_requests", `DELETE FROM message_requests WHERE sender_id = ?1 OR recipient_id = ?1`},
	{"trusted_senders", `DELETE FROM trusted_senders WHERE recipient_id = ?1 OR sender_id = ?1`},
	// NSFW acknowledgements (migration 047, class 18a): a consent
	// record naming the subject. The users delete below would cascade this
	// too, but class 18a has its own erasure rule in
	// docs/architecture/data-lifecycle.md, so it gets
	// its own explicit statement the inventory's zero is proved against —
	// the channel half needs none (ON DELETE CASCADE on channel_id).
	{"nsfw_acknowledgements", `DELETE FROM nsfw_acknowledgements WHERE user_id = ?`},
	{"gif_favorites", `DELETE FROM gif_favorites WHERE user_id = ?`},
	{"dm_participants", `DELETE FROM dm_participants WHERE user_id = ?`},
	// Group DM owner (migration 065): hand the group to its lowest remaining
	// member who is not banned, the same rule a leave applies (lowestMemberSQL),
	// so dm_owner_id keeps naming a current member. A group with no member left
	// gets NULL.
	{"group DM owner", `UPDATE channels SET dm_owner_id = ` + lowestMemberSQL("channels.id") + ` WHERE dm_owner_id = ?`},
	{"dm_open_state", `DELETE FROM dm_open_state WHERE user_id = ?`},
	{"invites created", `DELETE FROM invites WHERE created_by = ?`},
	{"invites redeemed", `UPDATE invites SET redeemed_by = NULL WHERE redeemed_by = ?`},
	// Invite redemption history (migration 055): a redemption row the subject
	// spent survives with its invite (and use_count) so the owner keeps the
	// count, but the link to the erased account is cut. Rows for the subject's
	// OWN invites are already gone via the invite_id cascade above.
	{"invite redemptions", `UPDATE invite_redemptions SET user_id = NULL WHERE user_id = ?`},
	// Replay events naming the subject are not here: the
	// drain walks the whole table in key windows, and the finish stage sweeps
	// only what was written since the lock (eraseSubjectRows), because a JSON
	// predicate over every row is the slowest statement of the lot.
}

// EventNamesUserPredicate is the SQL that decides whether a persisted replay
// event names a user, bound to the user's id as ?1. A persisted row is the
// wire envelope the hub sent, `{"seq":…,"type":…,"payload":{…}}`
// (ws.wrapWithSeq), so every lookup goes through $.payload: state frames
// carry user_id (presence, typing, reactions, voice, member_ban), message
// frames carry the author as user.id, chat frames list the mentioned ids
// under mentions, a call log row lists the people who joined under
// call.participants, a group add or remove row names its target as
// group_event.target_user_id, a relayed E2EE offer names its sender as from_user_id, and
// a presence_batch lists each user under updates[].user_id.
// ws.eventNamesUser is the same rule over the bytes in the ring buffer; the
// two must stay in step.
const EventNamesUserPredicate = `(json_extract(payload, '$.payload.user_id') = ?1
	 OR json_extract(payload, '$.payload.user.id') = ?1
	 OR json_extract(payload, '$.payload.from_user_id') = ?1
	 OR json_extract(payload, '$.payload.referenced_message.user.id') = ?1
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.mentions') WHERE json_each.value = ?1)
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.call.participants') WHERE json_each.value = ?1)
	 OR json_extract(payload, '$.payload.group_event.target_user_id') = ?1
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.updates') WHERE json_extract(json_each.value, '$.user_id') = ?1))`

// DeleteEventsForUser removes every persisted replay event naming userID —
// the erasure's own statement, run again after the member_ban broadcast and
// the persister flush so nothing queued or notified after the transaction
// survives (data-lifecycle O1 A4, O5). Returns rows deleted.
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

// erasureCollectFiles lists the stored_as names of every attachment the
// erasure is about to delete — uploaded by the subject (the avatar is one)
// or attached to a message the subject wrote — before the rows go.
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

// erasureReverseMentionCounts reverses the read_states.mention_count bumps
// the subject's own messages made, before those rows are deleted.
// DeleteMessage and PurgeMessages do this on every other message-removal
// path via DecrementMentionCounts; the erasure must too,
// or a mention badge from a message that no longer exists survives forever —
// mention_count is a stored counter nothing else ever zeroes. Inline rather
// than DecrementMentionCounts, which opens its own writer transaction.
//
// The subquery mirrors DecrementMentionCounts' guard: the readers each
// message's mention_receipts say it counted, undeleted messages past the
// recipient's last_message_id (a reader who has since marked the
// channel read is left alone), excluding mentions to a user who has blocked
// the departing author — mentionEntries (service/mentions.go) never
// counted those, so reversing them would wipe a genuine, unrelated
// badge on the same row. MAX(0, …) keeps the result monotonic.
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

// erasureDeleteLockouts removes the subject's rate-lockout keys (class 6):
// every key is "<prefix>:<value>" (auth.Key), the value the user id or the
// case-folded username. Matched on the exact suffix, not LIKE, so a username
// holding a wildcard character cannot widen the match.
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

// erasureReassignAssets moves the subject's emoji — server-wide assets — to
// the oldest remaining admin-class account, else to the oldest remaining
// account; with nobody left to own them the rows are deleted and their files
// returned for removal.
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

// erasureDeleteAssetRows deletes the subject's rows of one server-wide asset
// table (emoji or stickers, both with a filename and an uploaded_by column) and
// returns their stored file names. table is a fixed literal chosen by the caller.
func erasureDeleteAssetRows(ctx context.Context, tx *sql.Tx, table string, userID int64) ([]string, error) {
	// G202: table is a fixed literal from the caller, never request data.
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

// ListUnfinishedErasureJobs returns every job whose files are not yet gone,
// oldest first.
func (d *DB) ListUnfinishedErasureJobs(ctx context.Context) ([]ErasureJob, error) {
	rows, err := d.q.ListUnfinishedErasureJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListUnfinishedErasureJobs: %w", err)
	}
	jobs := make([]ErasureJob, 0, len(rows))
	for _, r := range rows {
		job, err := erasureJobFromRow(r.ID, r.UserID, r.State, r.Files, r.FilesRemoved, r.Attempts, r.LastError, r.ReplayPurged)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

// GetErasureJob returns one job by id, or ErrNotFound.
func (d *DB) GetErasureJob(ctx context.Context, id int64) (*ErasureJob, error) {
	r, err := d.q.GetErasureJob(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetErasureJob: %w", err)
	}
	job, err := erasureJobFromRow(r.ID, r.UserID, r.State, r.Files, r.FilesRemoved, r.Attempts, r.LastError, r.ReplayPurged)
	if err != nil {
		return nil, err
	}
	return &job, nil
}

// MarkErasureJobReplayPurged records that the job's replay purge succeeded.
func (d *DB) MarkErasureJobReplayPurged(ctx context.Context, id int64) error {
	if err := d.q.MarkErasureJobReplayPurged(ctx, id); err != nil {
		return fmt.Errorf("MarkErasureJobReplayPurged: %w", err)
	}
	return nil
}

func erasureJobFromRow(id, userID int64, state, files string, removed, attempts int64, lastErr *string, replayPurged int64) (ErasureJob, error) {
	job := ErasureJob{ID: id, UserID: userID, State: state, FilesRemoved: int(removed), Attempts: int(attempts), ReplayPurged: replayPurged != 0}
	if err := json.Unmarshal([]byte(files), &job.Files); err != nil {
		return ErasureJob{}, fmt.Errorf("erasure job %d: decode files: %w", id, err)
	}
	if job.Files == nil {
		job.Files = []string{}
	}
	if lastErr != nil {
		job.LastError = *lastErr
	}
	return job, nil
}

// RecordErasureJobAttempt records a run that left files behind: the count
// removed so far and the last error, and bumps the attempt counter.
func (d *DB) RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error {
	var errText *string
	if lastError != "" {
		errText = &lastError
	}
	if err := d.q.RecordErasureJobAttempt(ctx, dbgen.RecordErasureJobAttemptParams{FilesRemoved: int64(filesRemoved), LastError: errText, ID: id}); err != nil {
		return fmt.Errorf("RecordErasureJobAttempt: %w", err)
	}
	return nil
}

// CompleteErasureJob marks a job done: every listed file is gone.
func (d *DB) CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error {
	if err := d.q.CompleteErasureJob(ctx, dbgen.CompleteErasureJobParams{FilesRemoved: int64(filesRemoved), ID: id}); err != nil {
		return fmt.Errorf("CompleteErasureJob: %w", err)
	}
	return nil
}

// ReferencedStoredFiles reports which of names are still referenced by a
// row — an attachment's stored_as, an emoji's filename or a sticker's filename — for
// the storage reconciliation pass (data-lifecycle O3 A3): a file in the
// upload directory that no row names is stranded and may be removed.
func (d *DB) ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error) {
	referenced := make(map[string]bool, len(names))
	const chunk = 200
	for start := 0; start < len(names); start += chunk {
		end := min(start+chunk, len(names))
		batch := names[start:end]
		placeholders := make([]byte, 0, 2*len(batch))
		args := make([]any, 0, len(batch))
		for i, n := range batch {
			if i > 0 {
				placeholders = append(placeholders, ',')
			}
			placeholders = append(placeholders, '?')
			args = append(args, n)
		}
		in := string(placeholders)
		// G202: `in` is "?" placeholders only; every name is bound below.
		query := `SELECT stored_as FROM attachments WHERE stored_as IN (` + in + `)` + //nolint:gosec
			` UNION SELECT filename FROM emoji WHERE filename IN (` + in + `)` +
			` UNION SELECT filename FROM stickers WHERE filename IN (` + in + `)`
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
