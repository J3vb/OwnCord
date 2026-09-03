package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
}

// Erasure job states.
const (
	ErasureStateDBDone = "db_done"
	ErasureStateDone   = "done"
)

// EraseAccount hard-deletes every data class attributable to userID
// (docs/architecture/data-lifecycle.md, classes 1–20; class 21, the audit
// history, is B4-10's) in one transaction on the writer connection, with
// PRAGMA secure_delete on for that transaction so the erased rows' bytes do
// not survive in freed pages (HP-4 decision 2), and truncates the WAL after
// commit. The last-admin guard and the OC-0294/OC-0293 mention-count
// reversal are kept from the anonymising deletion this replaces.
//
// Children are deleted before the users row: messages.user_id,
// invites.created_by and emoji.uploaded_by carry no ON DELETE action,
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
// Returns ErrLastAdmin when the subject is the last admin-class account and
// ErrNotFound when no such user exists. Nothing is logged here by username.
func (d *DB) EraseAccount(ctx context.Context, userID int64) (*ErasureJob, error) {
	conn, err := d.writer.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount conn: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	// secure_delete is per connection. The writer pool is one connection, so
	// this is the connection every later write uses too; restore it after.
	var prevSecureDelete int
	if err := conn.QueryRowContext(ctx, `PRAGMA secure_delete`).Scan(&prevSecureDelete); err != nil {
		return nil, fmt.Errorf("EraseAccount read secure_delete: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA secure_delete = ON`); err != nil {
		return nil, fmt.Errorf("EraseAccount secure_delete: %w", err)
	}
	defer func() {
		if _, err := conn.ExecContext(context.WithoutCancel(ctx), fmt.Sprintf(`PRAGMA secure_delete = %d`, prevSecureDelete)); err != nil {
			slog.Warn("erasure: could not restore secure_delete", "user_id", userID, "err", err)
		}
	}()

	job, err := eraseAccountTx(ctx, conn, userID)
	if err != nil {
		return nil, err
	}

	// The WAL still holds the transaction's frames, erased bytes included,
	// until a checkpoint copies them into the main file and TRUNCATE drops
	// the log. Best effort: a reader mid-transaction makes the checkpoint
	// partial and the next one finishes it.
	var busy, logFrames, checkpointed int
	if err := conn.QueryRowContext(context.WithoutCancel(ctx), `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed); err != nil {
		slog.Warn("erasure: WAL checkpoint failed", "user_id", userID, "err", err)
	} else if busy != 0 || (logFrames >= 0 && checkpointed < logFrames) {
		slog.Info("erasure: WAL checkpoint incomplete, the next checkpoint finishes it", "user_id", userID, "busy", busy, "log", logFrames, "checkpointed", checkpointed)
	}
	return job, nil
}

// eraseAccountTx is EraseAccount's transaction.
func eraseAccountTx(ctx context.Context, conn *sql.Conn, userID int64) (*ErasureJob, error) {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var username string
	if err := tx.QueryRowContext(ctx, `SELECT username FROM users WHERE id = ?`, userID).Scan(&username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("EraseAccount user %d: %w", userID, ErrNotFound)
		}
		return nil, fmt.Errorf("EraseAccount fetch user: %w", err)
	}
	if err := deleteAccountAdminGuard(ctx, tx, userID); err != nil {
		return nil, err
	}
	dmChannelIDs, err := deleteAccountDMChannels(ctx, tx, userID)
	if err != nil {
		return nil, err
	}

	files, err := erasureCollectFiles(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := erasureReverseMentionCounts(ctx, tx, userID); err != nil {
		return nil, err
	}
	if err := erasureDeleteLockouts(ctx, tx, userID, username); err != nil {
		return nil, err
	}
	for _, s := range erasureStatements {
		if _, err := tx.ExecContext(ctx, s.query, userID); err != nil {
			return nil, fmt.Errorf("EraseAccount %s: %w", s.label, err)
		}
	}
	assetFiles, err := erasureReassignAssets(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	files = append(files, assetFiles...)
	if err := deleteAccountCloseDMChannels(ctx, tx, userID, dmChannelIDs); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID); err != nil {
		return nil, fmt.Errorf("EraseAccount users: %w", err)
	}

	encoded, err := json.Marshal(files)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount encode files: %w", err)
	}
	jobID, err := dbgen.New(tx).InsertErasureJob(ctx, dbgen.InsertErasureJobParams{UserID: userID, Files: string(encoded)})
	if err != nil {
		return nil, fmt.Errorf("EraseAccount job: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("EraseAccount commit: %w", err)
	}
	return &ErasureJob{ID: jobID, UserID: userID, State: ErasureStateDBDone, Files: files}, nil
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
	{"attachments", `DELETE FROM attachments WHERE uploader_id = ?1 OR message_id IN (SELECT id FROM messages WHERE user_id = ?1)`},
	// The messages_ad trigger (migration 001) drops each row from the FTS
	// index; message_mentions and reactions on these rows cascade.
	{"messages", `DELETE FROM messages WHERE user_id = ?`},
	{"reactions", `DELETE FROM reactions WHERE user_id = ?`},
	{"read_states", `DELETE FROM read_states WHERE user_id = ?`},
	{"sessions", `DELETE FROM sessions WHERE user_id = ?`},
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
	{"user_blocks", `DELETE FROM user_blocks WHERE blocker_id = ?1 OR blocked_id = ?1`},
	{"channel_user_overrides", `DELETE FROM channel_user_overrides WHERE user_id = ?`},
	{"dm_participants", `DELETE FROM dm_participants WHERE user_id = ?`},
	{"dm_open_state", `DELETE FROM dm_open_state WHERE user_id = ?`},
	{"invites created", `DELETE FROM invites WHERE created_by = ?`},
	{"invites redeemed", `UPDATE invites SET redeemed_by = NULL WHERE redeemed_by = ?`},
	// Replay events naming the subject (HP-4 decision 1).
	{"events", `DELETE FROM events WHERE ` + EventNamesUserPredicate},
}

// EventNamesUserPredicate is the SQL that decides whether a persisted replay
// event names a user, bound to the user's id as ?1. A persisted row is the
// wire envelope the hub sent, `{"seq":…,"type":…,"payload":{…}}`
// (ws.wrapWithSeq), so every lookup goes through $.payload: state frames
// carry user_id (presence, typing, reactions, voice, member_ban), message
// frames carry the author as user.id, chat frames list the mentioned ids
// under mentions, and a relayed E2EE offer names its sender as
// from_user_id. ws.eventNamesUser is the same rule over the bytes in the
// ring buffer; the two must stay in step.
const EventNamesUserPredicate = `(json_extract(payload, '$.payload.user_id') = ?1
	 OR json_extract(payload, '$.payload.user.id') = ?1
	 OR json_extract(payload, '$.payload.from_user_id') = ?1
	 OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.mentions') WHERE json_each.value = ?1))`

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
// path via DecrementMentionCounts (OC-0275); the erasure must too (OC-0294),
// or a mention badge from a message that no longer exists survives forever —
// mention_count is a stored counter nothing else ever zeroes. Inline rather
// than DecrementMentionCounts, which opens its own writer transaction.
//
// The subquery mirrors DecrementMentionCounts' guard: undeleted messages
// past the recipient's last_message_id (a reader who has since marked the
// channel read is left alone), excluding mentions to a user who has blocked
// the departing author — applyMentionCounts (service/mentions.go) never
// counted those (OC-0293), so reversing them would wipe a genuine, unrelated
// badge on the same row. MAX(0, …) keeps the result monotonic.
func erasureReverseMentionCounts(ctx context.Context, tx *sql.Tx, userID int64) error {
	_, err := tx.ExecContext(ctx,
		`UPDATE read_states
		 SET mention_count = MAX(0, mention_count - (
		     SELECT COUNT(*)
		     FROM message_mentions mm
		     JOIN messages m ON m.id = mm.message_id
		     WHERE mm.mentioned_user_id = read_states.user_id
		       AND m.channel_id = read_states.channel_id
		       AND m.user_id = ?
		       AND m.deleted = 0
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
		`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
		  WHERE u.id != ?
		  ORDER BY CASE WHEN r.id IN (?, ?) OR (r.permissions & ?) != 0 THEN 0 ELSE 1 END, u.id
		  LIMIT 1`,
		userID, permissions.OwnerRoleID, permissions.AdminRoleID, permissions.Administrator,
	).Scan(&heir)
	switch {
	case err == nil:
		if _, err := tx.ExecContext(ctx, `UPDATE emoji SET uploaded_by = ? WHERE uploaded_by = ?`, heir, userID); err != nil {
			return nil, fmt.Errorf("EraseAccount reassign emoji: %w", err)
		}
		return nil, nil
	case errors.Is(err, sql.ErrNoRows):
		rows, err := tx.QueryContext(ctx, `DELETE FROM emoji WHERE uploaded_by = ? RETURNING filename`, userID)
		if err != nil {
			return nil, fmt.Errorf("EraseAccount delete emoji: %w", err)
		}
		defer rows.Close() //nolint:errcheck
		var files []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return nil, fmt.Errorf("EraseAccount scan emoji: %w", err)
			}
			files = append(files, name)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("EraseAccount emoji rows: %w", err)
		}
		return files, nil
	default:
		return nil, fmt.Errorf("EraseAccount asset heir: %w", err)
	}
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
		job, err := erasureJobFromRow(r.ID, r.UserID, r.State, r.Files, r.FilesRemoved, r.Attempts, r.LastError)
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
	job, err := erasureJobFromRow(r.ID, r.UserID, r.State, r.Files, r.FilesRemoved, r.Attempts, r.LastError)
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func erasureJobFromRow(id, userID int64, state, files string, removed, attempts int64, lastErr *string) (ErasureJob, error) {
	job := ErasureJob{ID: id, UserID: userID, State: state, FilesRemoved: int(removed), Attempts: int(attempts)}
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
// row — an attachment's stored_as or an emoji's filename — for
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
			` UNION SELECT filename FROM emoji WHERE filename IN (` + in + `)`
		all := make([]any, 0, 2*len(args))
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
