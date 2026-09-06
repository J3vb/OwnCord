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
// subjectToken is the deletion marker's token for the subject (B4-10): the
// audit rows the subject appears in keep their action, time and order but
// lose the id — actor_id / target_id become 0, detail is cleared — and carry
// the token instead. An empty token unlinks the rows without one.
//
// Returns ErrLastAdmin when the subject is the last admin-class account and
// ErrNotFound when no such user exists. Nothing is logged here by username.
func (d *DB) EraseAccount(ctx context.Context, userID int64, subjectToken string) (*ErasureJob, error) {
	return d.eraseAccount(ctx, userID, subjectToken, true)
}

// ReplayEraseAccount is EraseAccount for a deletion-marker replay (B4-10,
// MarkerStore.ReplayAccounts): the same transaction without the last-admin
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
// can write the deletion marker before the transaction (B4-10) without
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
		  WHERE role_id IN (SELECT id FROM roles WHERE id IN (?, ?) OR (permissions & ?) != 0)
		    AND `+notBannedClause,
		permissions.OwnerRoleID, permissions.AdminRoleID, permissions.Administrator).Scan(&n); err != nil {
		return 0, fmt.Errorf("CountAdminClassAccounts: %w", err)
	}
	return n, nil
}

// eraseAccount is EraseAccount and ReplayEraseAccount: guard selects the
// last-admin guard.
func (d *DB) eraseAccount(ctx context.Context, userID int64, subjectToken string, guard bool) (*ErasureJob, error) {
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

	job, err := eraseAccountTx(ctx, conn, userID, subjectToken, guard)
	if err != nil {
		return nil, err
	}
	// The audit writer's rule for the subject, now that the transaction has
	// committed and while this connection is still held: an audit entry
	// about the subject that a flush inserts after the UPDATE above is
	// written unlinked (AuditWriter.Unlink), and a refused transaction has
	// installed nothing.
	d.unlinkAuditsFor(userID, subjectToken)

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

// eraseAccountTx is EraseAccount's transaction; guard selects the
// last-admin guard (off for a marker replay).
func eraseAccountTx(ctx context.Context, conn *sql.Conn, userID int64, subjectToken string, guard bool) (*ErasureJob, error) {
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
	if guard {
		if err := deleteAccountAdminGuard(ctx, tx, userID); err != nil {
			return nil, err
		}
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
	if err := erasureUnlinkPrincipalRows(ctx, tx, userID, subjectToken); err != nil {
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
	// The upload byte counter (migration 044, B5-2, class 12a): a counter
	// keyed by user_id that survived would be a residue naming the subject.
	// The users delete below would cascade it too; this is the explicit
	// statement the inventory's zero is proved against.
	{"user_storage", `DELETE FROM user_storage WHERE user_id = ?`},
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
	// Retention policy setter (migration 039, B4-11): no FK, so the id
	// otherwise outlives the erasure. The policy stays in effect — only the
	// link to who set it is cut, as with the recovery_assists issuer above.
	{"channel_retention setter", `UPDATE channel_retention SET updated_by = 0 WHERE updated_by = ?`},
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

// erasureUnlinkPrincipalRows runs every "an erased user acted here" unlink in
// one call — audit_log, reports, and moderation_actions — so eraseAccountTx
// carries one branch for the group instead of one per table (kept under the
// cyclop budget; the three are independent and each already reports its own
// wrapped error).
func erasureUnlinkPrincipalRows(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	if err := erasureUnlinkAudit(ctx, tx, userID, subjectToken); err != nil {
		return err
	}
	if err := erasureUnlinkReports(ctx, tx, userID, subjectToken); err != nil {
		return err
	}
	if err := erasureUnlinkModerationActions(ctx, tx, userID, subjectToken); err != nil {
		return err
	}
	return erasureUnlinkAppeals(ctx, tx, userID, subjectToken)
}

// erasureUnlinkAudit is the unlinkable integrity history (B4-10, BPR-053):
// every audit row the subject appears in — as actor, or as a user target —
// keeps its action, time and position but loses the id and its free-text
// detail, and carries the deletion marker's token instead (NULL when the
// erasure ran without a marker store): in actor_token where the subject
// acted, in subject_token where they were the target, so a row naming two
// erased subjects keeps both (migration 041). "An erasure happened, by this
// actor class, at this time" survives; "of whom" needs the erasure key.
func erasureUnlinkAudit(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE audit_log SET actor_id = 0, detail = '', actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink audit actor: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE audit_log SET target_id = 0, detail = '', subject_token = ? WHERE target_type = 'user' AND target_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink audit target: %w", err)
	}
	return nil
}

// erasureUnlinkReports is B5-8's half of decision 7 (strengthened on
// review): a report names two principals — the reporter and the subject —
// each with its own bare-id-plus-token column, the same two-token shape
// erasureUnlinkAudit applies to audit_log (migrations 038/041), for the same
// reason: one erased principal must not overwrite the other's token.
//
// On the SUBJECT's erasure: every evidence row of every report about them,
// and every evidence row they authored as context in someone else's report,
// is hard-deleted — this is the half that keeps B4-9's signed exit condition
// true, a restored backup cannot resurrect the content. The reports row
// itself SURVIVES, rewritten to id 0 plus the token, detail and target_ref
// cleared, and — if still open — closed as subject_erased: an unlinkable
// outcome row, action/time/order and the token, nothing else (S5-d). An
// implementation that deletes the row instead of rewriting it passes a test
// that only checks the content is gone and fails the negative control that
// checks the row (and its state) survives — this is the abuse path decision
// 7 was strengthened to close: report someone, they erase, no trace the
// report ever existed.
//
// On the REPORTER's erasure: only reporter_id/reporter_token change. The
// report and its outcome are not the reporter's content and must not be
// touched otherwise (TestReport_ReporterErasureKeepsTheReport).
//
// Notes and evidence authored by an erased MODERATOR, and assignments to
// them, are unlinked the same way everywhere else in this file unlinks an
// actor: id to 0, token filled.
func erasureUnlinkReports(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	// 22c: evidence authored by the subject anywhere (their own reports' seq
	// 0, or context rows in someone else's report) is content and is
	// hard-deleted, not unlinked.
	if _, err := tx.ExecContext(ctx, `DELETE FROM report_evidence WHERE author_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence authored: %w", err)
	}
	// 22a: every evidence row of a report ABOUT the subject is content too.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_evidence WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence about subject: %w", err)
	}
	// HP-5 review widening: the surviving outcome row must carry no content
	// of any kind, and internal notes about the subject are content the
	// subject never even saw — they do not get to keep the moderator's own
	// account of them either.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_notes WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report notes about subject: %w", err)
	}
	// 22a: the reports row about the subject survives, rewritten.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports
		    SET subject_id = 0,
		        subject_token = ?,
		        detail = '',
		        target_ref = '',
		        state = CASE WHEN closed_at IS NULL THEN 'subject_erased' ELSE state END,
		        outcome = CASE WHEN closed_at IS NULL THEN 'subject_erased' ELSE outcome END,
		        closed_at = COALESCE(closed_at, datetime('now')),
		        updated_at = datetime('now')
		  WHERE subject_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report subject: %w", err)
	}
	// 22b: the reporter's own reports are not their content, EXCEPT the
	// free-text detail they personally wrote — that is the reporter's
	// content just as much as the evidence snapshot is the subject's, so it
	// is cleared alongside the principal columns (HP-5 review widening).
	// The report and its outcome (state/outcome/closed_at) are untouched.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports SET reporter_id = 0, reporter_token = ?, detail = '' WHERE reporter_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report reporter: %w", err)
	}
	// 22d: notes authored by an erased moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_notes SET author_id = 0, author_token = ? WHERE author_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report notes: %w", err)
	}
	// 22e: assignments to an erased moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports SET assignee_id = 0 WHERE assignee_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report assignment: %w", err)
	}
	// 22f: report_events (second Codex review) is metadata, not content — an
	// action word, a time, an actor link — so unlinking the actor is the
	// whole job, the same shape audit_log gets, and there is no row to
	// delete or rewrite otherwise.
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_events SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report events: %w", err)
	}
	return nil
}

// erasureUnlinkModerationActions is B5-9's half of erasure, beside
// erasureUnlinkReports: the SUBJECT's own rows cascade with the users DELETE
// below (moderation_actions.target_id is ON DELETE CASCADE — S6 says a
// warning or timeout row is deleted, not kept, unlike a report's outcome),
// so there is nothing for this function to do on that side. What it unlinks
// is the erased user acting as a MODERATOR elsewhere: actor_id/actor_token
// (the bare-id-plus-token pattern erasureUnlinkAudit and erasureUnlinkReports
// both use) and lifted_by (a bare id with no token column, mirroring
// reports.assignee_id — inventory classes 23a and 23b, SubjectInventory).
func erasureUnlinkModerationActions(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	// 23b: actions taken BY the subject as a moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE moderation_actions SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink moderation action actor: %w", err)
	}
	// A timeout lifted by the erased moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE moderation_actions SET lifted_by = 0 WHERE lifted_by = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink moderation action lifter: %w", err)
	}
	return nil
}

// erasureUnlinkAppeals is B5-10's half of erasure, beside
// erasureUnlinkModerationActions: the APPELLANT's own appeal rows cascade
// with the users DELETE below (appeals.appellant_id is ON DELETE CASCADE —
// S6-d says an appeal is deleted for the appellant, not kept, unlike a
// report's outcome row: the UNIQUE(action_id) memory that forbids re-appeal
// survives with the row gone, because the action itself still exists and a
// fresh appeal against it would need a fresh appellant who no longer
// exists either), so there is nothing for this function to do on that side.
// What it unlinks is the erased user acting as a MODERATOR elsewhere:
// decided_by/decided_by_token (the bare-id-plus-token pattern every other
// unlinker in this file uses) and assignee_id (a bare id with no token
// column, mirroring reports.assignee_id and moderation_actions.lifted_by —
// inventory class 24b, SubjectInventory).
func erasureUnlinkAppeals(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE appeals SET decided_by = 0, decided_by_token = ? WHERE decided_by = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink appeal decider: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE appeals SET assignee_id = 0 WHERE assignee_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink appeal assignment: %w", err)
	}
	return nil
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
