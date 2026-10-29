package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// EraseAccountFinish is the finish stage: the single transaction that used
// to be the whole erasure, run over tables the drain left nearly empty. Every
// statement is idempotent, so it also sweeps whatever a send that passed auth
// before the lock wrote since. It ends by turning the subject's queued job
// into db_done with the union of the files every stage collected. After the
// commit it unlinks the audit history and truncates the WAL, once.
//
// subjectToken is the deletion marker's token for the subject: the
// audit rows the subject appears in keep their action, time and order but
// lose the id — actor_id / target_id become 0, detail is cleared — and carry
// the token instead. An empty token unlinks the rows without one.
//
// A subject whose users row is already gone (a stage interrupted after the
// delete would leave none, but a restore or an operator can) only has its job
// closed.
func (d *DB) EraseAccountFinish(ctx context.Context, userID int64, subjectToken string) (*ErasureJob, error) {
	var job *ErasureJob
	err := d.withErasureConn(ctx, userID, func(conn *sql.Conn) error {
		var err error
		job, err = eraseFinishTx(ctx, conn, userID, subjectToken)
		if err != nil {
			return err
		}
		if err := d.erasureHook("finish", 0); err != nil {
			return err
		}
		// Crash seam: the transaction has committed and the
		// checkpoint below has not run, which is the window a test needs to
		// read the bytes as a crash leaves them. Nil in production.
		if d.testEraseCommitHook != nil {
			d.testEraseCommitHook()
		}
		// The audit writer's rule for the subject, now that the transaction
		// has committed and while this connection is still held: an audit
		// entry about the subject that a flush inserts after the UPDATE in
		// the transaction is written unlinked (AuditWriter.Unlink), and a
		// refused transaction has installed nothing.
		d.unlinkAuditsFor(userID, subjectToken)
		d.checkpointAfterErasure(ctx, conn, userID)
		return d.erasureHook("checkpoint", 0)
	})
	if err != nil {
		return nil, err
	}
	return job, nil
}

// eraseFinishTx is the finish stage's transaction.
func eraseFinishTx(ctx context.Context, conn *sql.Conn, userID int64, subjectToken string) (*ErasureJob, error) {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := dbgen.New(tx)
	queued, err := q.GetQueuedErasureJobForUser(ctx, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("EraseAccount queued job for user %d: %w", userID, ErrNotFound)
		}
		return nil, fmt.Errorf("EraseAccount queued job: %w", err)
	}
	var files []string
	if err := json.Unmarshal([]byte(queued.Files), &files); err != nil {
		return nil, fmt.Errorf("EraseAccount decode queued files: %w", err)
	}

	var username string
	err = tx.QueryRowContext(ctx, `SELECT username FROM users WHERE id = ?`, userID).Scan(&username)
	switch {
	case err == nil:
		more, err := eraseSubjectRows(ctx, tx, userID, username, subjectToken, queued.ID)
		if err != nil {
			return nil, err
		}
		files = append(files, more...)
	case errors.Is(err, sql.ErrNoRows):
		// Nothing left to delete: only the job is outstanding.
	default:
		return nil, fmt.Errorf("EraseAccount fetch user: %w", err)
	}

	files = uniqueNames(files)
	encoded, err := json.Marshal(files)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount encode files: %w", err)
	}
	n, err := q.MarkErasureJobDBDone(ctx, dbgen.MarkErasureJobDBDoneParams{Files: string(encoded), ID: queued.ID})
	if err != nil {
		return nil, fmt.Errorf("EraseAccount job: %w", err)
	}
	if n != 1 {
		return nil, fmt.Errorf("EraseAccount job %d: %w", queued.ID, ErrNotFound)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("EraseAccount commit: %w", err)
	}
	return &ErasureJob{ID: queued.ID, UserID: userID, State: ErasureStateDBDone, Files: files}, nil
}

// eraseSubjectRows is the whole-account deletion the single transaction used
// to be, and returns the stored names of the files it unlinked.
func eraseSubjectRows(ctx context.Context, tx *sql.Tx, userID int64, username, subjectToken string, jobID int64) ([]string, error) {
	dmChannelIDs, err := deleteAccountDMChannels(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	files, err := erasureCollectFiles(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	// Mention badges are reversed only while the subject still has messages
	// to reverse them for; the drain has taken the rest (chunk by chunk).
	var has int
	switch err := tx.QueryRowContext(ctx, `SELECT 1 FROM messages WHERE user_id = ? LIMIT 1`, userID).Scan(&has); {
	case err == nil:
		if err := erasureReverseMentionCounts(ctx, tx, userID); err != nil {
			return nil, err
		}
	case errors.Is(err, sql.ErrNoRows):
	default:
		return nil, fmt.Errorf("EraseAccount remaining messages: %w", err)
	}
	if err := erasureDeleteLockouts(ctx, tx, userID, username); err != nil {
		return nil, err
	}
	for _, s := range erasureStatements {
		if _, err := tx.ExecContext(ctx, s.query, userID); err != nil {
			return nil, fmt.Errorf("EraseAccount %s: %w", s.label, err)
		}
	}
	// Replay events naming the subject. The drain has taken
	// every one that existed before the lock, so the sweep here is the rows
	// written since: the job's created_at is the lock's time, and the
	// created_at index turns the JSON predicate's table scan into a range.
	// PurgeUserFromReplay deletes them all again after the member_ban.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM events WHERE created_at >= (SELECT created_at FROM erasure_jobs WHERE id = ?2) AND `+EventNamesUserPredicate,
		userID, jobID); err != nil {
		return nil, fmt.Errorf("EraseAccount events: %w", err)
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
	return files, nil
}

// uniqueNames sorts names and drops repeats: the union of the files the drain
// chunks journaled and the finish stage collected.
func uniqueNames(names []string) []string {
	out := slices.Clone(names)
	slices.Sort(out)
	out = slices.Compact(out)
	if out == nil {
		return []string{}
	}
	return out
}
