package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Chunked account erasure. One writer connection serves every request, so a
// single transaction deleting a prolific account's history would hold every
// other write behind it. The erasure is three stages, each its own short
// writer transaction:
//
//  1. Lock (EraseAccountLock): the point of no return. Runs the last-admin
//     guard, records a 'queued' erasure_jobs row, and revokes the subject's
//     sessions, API tokens and half-finished logins.
//  2. Drain (EraseAccountDrain): deletes the bulky per-user tables in chunks
//     of at most erasureChunk rows, one transaction each. Attachment names
//     are appended to the queued row in the chunk that unlinks them.
//  3. Finish (EraseAccountFinish): the single-transaction body over tables
//     already nearly empty, moving the row from 'queued' to 'db_done'.
//
// Every statement is idempotent, so an interrupted stage, or a drain never
// started, is repeated by the next caller. database/sql hands a returned writer
// connection to its longest-waiting caller, so other writers get a turn between
// chunks.

// ErasureStateQueued is the state of a job whose lock stage has committed and
// whose finish stage has not: the account is locked and part of its data is
// still there.
const ErasureStateQueued = "queued"

// Chunk sizes. Package variables so tests can shrink them; no config key
// because nothing has measured a better number.
var (
	// erasureChunk is the most rows one drain transaction deletes from an
	// indexed per-user predicate (and the most messages it removes).
	erasureChunk = 500
	// erasureScanWindow is the most key values one drain transaction walks
	// for a table with no index on the user column (reactions, events).
	erasureScanWindow = 5000
)

// erasureHook runs the test seam testErasureChunkHook after each chunked
// erasure transaction commits, with the stage ("lock", "chunk", "finish",
// "checkpoint") and, for "chunk", the 1-based count of chunks committed. A
// non-nil error aborts the erasure there, standing in for a crash mid-drain;
// the hook may block to hold the erasure between stages. Nil in production.
func (d *DB) erasureHook(stage string, n int) error {
	if d.testErasureChunkHook == nil {
		return nil
	}
	return d.testErasureChunkHook(stage, n)
}

// withErasureConn runs fn on the writer connection with PRAGMA secure_delete
// ON, so erased bytes do not survive in freed pages, and restores it
// afterwards. secure_delete is per connection and the writer pool is one
// connection, so later writes use it too.
func (d *DB) withErasureConn(ctx context.Context, userID int64, fn func(conn *sql.Conn) error) error {
	conn, err := d.writer.Conn(ctx)
	if err != nil {
		return fmt.Errorf("EraseAccount conn: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	var prevSecureDelete int
	if err := conn.QueryRowContext(ctx, `PRAGMA secure_delete`).Scan(&prevSecureDelete); err != nil {
		return fmt.Errorf("EraseAccount read secure_delete: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA secure_delete = ON`); err != nil {
		return fmt.Errorf("EraseAccount secure_delete: %w", err)
	}
	defer func() {
		if _, err := conn.ExecContext(context.WithoutCancel(ctx), fmt.Sprintf(`PRAGMA secure_delete = %d`, prevSecureDelete)); err != nil {
			slog.Warn("erasure: could not restore secure_delete", "user_id", userID, "err", err)
		}
	}()
	return fn(conn)
}

// eraseAccount is EraseAccount and ReplayEraseAccount: all three stages with
// no time budget. guard selects the last-admin guard.
func (d *DB) eraseAccount(ctx context.Context, userID int64, subjectToken string, guard bool) (*ErasureJob, error) {
	if _, err := d.EraseAccountLock(ctx, userID, guard); err != nil {
		return nil, err
	}
	if _, err := d.EraseAccountDrain(ctx, userID, time.Time{}); err != nil {
		return nil, err
	}
	return d.EraseAccountFinish(ctx, userID, subjectToken)
}

// EraseAccountLock is the lock stage: the last-admin guard (when guard is set
// and no job is queued yet), then one transaction that finds or inserts the
// subject's queued job and deletes their sessions, API tokens and
// partial-auth challenges. It returns ErrLastAdmin and ErrNotFound as
// EraseAccount does, changing nothing. After a nil error the erasure is
// committed to: the caller finishes it now or leaves it to Resume.
func (d *DB) EraseAccountLock(ctx context.Context, userID int64, guard bool) (*ErasureJob, error) {
	var job *ErasureJob
	err := d.withErasureConn(ctx, userID, func(conn *sql.Conn) error {
		var err error
		job, err = eraseLockTx(ctx, conn, userID, guard)
		return err
	})
	if err != nil {
		return nil, err
	}
	// The lock has committed: a test hook here must not return an error, or the
	// caller would treat a committed lock as nothing changed.
	if err := d.erasureHook("lock", 0); err != nil {
		return nil, err
	}
	return job, nil
}

func eraseLockTx(ctx context.Context, conn *sql.Conn, userID int64, guard bool) (*ErasureJob, error) {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("EraseAccount begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var one int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, userID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("EraseAccount user %d: %w", userID, ErrNotFound)
		}
		return nil, fmt.Errorf("EraseAccount fetch user: %w", err)
	}
	q := dbgen.New(tx)
	job := &ErasureJob{UserID: userID, State: ErasureStateQueued, Files: []string{}}
	queued, err := q.GetQueuedErasureJobForUser(ctx, userID)
	switch {
	case err == nil:
		// A job already queued passed the guard when it was queued.
		job.ID = queued.ID
		if err := json.Unmarshal([]byte(queued.Files), &job.Files); err != nil {
			return nil, fmt.Errorf("EraseAccount decode queued files: %w", err)
		}
	case errors.Is(err, sql.ErrNoRows):
		if guard {
			if err := deleteAccountAdminGuard(ctx, tx, userID); err != nil {
				return nil, err
			}
		}
		job.ID, err = q.InsertQueuedErasureJob(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("EraseAccount job: %w", err)
		}
	default:
		return nil, fmt.Errorf("EraseAccount queued job: %w", err)
	}
	for _, s := range erasureLockStatements {
		if _, err := tx.ExecContext(ctx, s.query, userID); err != nil {
			return nil, fmt.Errorf("EraseAccount %s: %w", s.label, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("EraseAccount commit lock: %w", err)
	}
	return job, nil
}

// erasureLockStatements revoke every credential the subject holds, so the
// account stops working at the lock, not at the end of the drain.
var erasureLockStatements = []struct{ label, query string }{
	{"sessions", `DELETE FROM sessions WHERE user_id = ?`},
	{"api_tokens", `DELETE FROM api_tokens WHERE user_id = ?`},
	{"partial_auth_challenges", `DELETE FROM partial_auth_challenges WHERE user_id = ?`},
}

// drainResult is what one chunk transaction reports.
type drainResult struct {
	// done: the step has nothing left to delete.
	done bool
	// next: the cursor for the following chunk of a windowed step.
	next int64
	// files: stored_as names the chunk unlinked, to be appended to the job.
	files []string
}

// drainStep deletes one chunk of one per-user table inside tx; cursor is the
// previous chunk's next (zero at the start).
type drainStep struct {
	label string
	run   func(ctx context.Context, tx *sql.Tx, userID, cursor int64) (drainResult, error)
}

// EraseAccountDrain is the drain stage: it deletes the subject's rows from the
// bulky tables, one chunk per writer transaction, in erasureStatements order.
// It stops early with done=false once deadline has passed between chunks (a
// zero deadline never stops). Safe on an already-drained account and to repeat
// after an error.
func (d *DB) EraseAccountDrain(ctx context.Context, userID int64, deadline time.Time) (bool, error) {
	chunks := 0
	for _, step := range erasureDrainSteps {
		cursor := int64(0)
		for {
			if !deadline.IsZero() && !time.Now().Before(deadline) {
				return false, nil
			}
			var res drainResult
			err := d.withErasureConn(ctx, userID, func(conn *sql.Conn) error {
				var err error
				res, err = drainChunk(ctx, conn, step, userID, cursor)
				return err
			})
			if err != nil {
				return false, err
			}
			chunks++
			cursor = res.next
			if err := d.erasureHook("chunk", chunks); err != nil {
				return false, err
			}
			if res.done {
				break
			}
		}
	}
	return true, nil
}

func drainChunk(ctx context.Context, conn *sql.Conn, step drainStep, userID, cursor int64) (drainResult, error) {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return drainResult{}, fmt.Errorf("EraseAccount drain %s begin tx: %w", step.label, err)
	}
	defer tx.Rollback() //nolint:errcheck
	res, err := step.run(ctx, tx, userID, cursor)
	if err != nil {
		return drainResult{}, fmt.Errorf("EraseAccount drain %s: %w", step.label, err)
	}
	if len(res.files) > 0 {
		if err := appendErasureJobFiles(ctx, tx, userID, res.files); err != nil {
			return drainResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return drainResult{}, fmt.Errorf("EraseAccount drain %s commit: %w", step.label, err)
	}
	return res, nil
}

// appendErasureJobFiles adds names to the subject's queued job in the same
// transaction that unlinked them (as appendRetentionRunBatch does); the job is
// the only handle left on the blobs once the attachment rows go.
func appendErasureJobFiles(ctx context.Context, tx *sql.Tx, userID int64, names []string) error {
	q := dbgen.New(tx)
	queued, err := q.GetQueuedErasureJobForUser(ctx, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("EraseAccount drain job for user %d: %w", userID, ErrNotFound)
		}
		return fmt.Errorf("EraseAccount drain job: %w", err)
	}
	var have []string
	if err := json.Unmarshal([]byte(queued.Files), &have); err != nil {
		return fmt.Errorf("EraseAccount drain decode files: %w", err)
	}
	encoded, err := json.Marshal(append(have, names...))
	if err != nil {
		return fmt.Errorf("EraseAccount drain encode files: %w", err)
	}
	n, err := q.AppendErasureJobFiles(ctx, dbgen.AppendErasureJobFilesParams{Files: string(encoded), ID: queued.ID})
	if err != nil {
		return fmt.Errorf("EraseAccount drain journal: %w", err)
	}
	if n != 1 {
		return fmt.Errorf("EraseAccount drain journal job %d: %w", queued.ID, ErrNotFound)
	}
	return nil
}

// sessionRowID reads the id of the session row InsertSession wrote. Sign-in is
// refused while an account deletion completes: the insert writes no row for a
// user with a queued erasure job, reported as ErrAccountErasing.
func sessionRowID(res sql.Result, err error, userID int64) (int64, error) {
	if err != nil {
		return 0, fmt.Errorf("CreateSession: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return 0, fmt.Errorf("CreateSession rows: %w", err)
	} else if n == 0 {
		return 0, fmt.Errorf("CreateSession user %d: %w", userID, ErrAccountErasing)
	}
	return res.LastInsertId()
}

// refuseWhileErasing fails a write for a user whose deletion is being
// completed. Inside the writer transaction it cannot interleave with the lock
// stage, so nothing the drain has passed is written again.
func refuseWhileErasing(ctx context.Context, tx *sql.Tx, userID int64) error {
	var one int
	err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM erasure_jobs WHERE user_id = ? AND state = 'queued' LIMIT 1`, userID).Scan(&one)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil
	case err != nil:
		return fmt.Errorf("erasure check: %w", err)
	}
	return fmt.Errorf("user %d: %w", userID, ErrAccountErasing)
}
