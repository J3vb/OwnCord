package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// eraseInlineBudget is how long Erase drives the drain stage itself before it
// hands the rest to the maintenance loop. With the lock, the finish and the
// file removals on top it stays under the HTTP server's 30 s WriteTimeout, so a request still answers while most accounts finish inline,
// as they did when the erasure was one transaction. A variable so tests can
// shrink it.
var eraseInlineBudget = 12 * time.Second

// ErasureStageStore is the database half of a live erasure in three short
// writer transactions (db.EraseAccountLock, EraseAccountDrain,
// EraseAccountFinish); the file half is journaled in erasure_jobs.
type ErasureStageStore interface {
	EraseAccountLock(ctx context.Context, userID int64, guard bool) (*db.ErasureJob, error)
	EraseAccountDrain(ctx context.Context, userID int64, deadline time.Time) (bool, error)
	EraseAccountFinish(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	GetErasureJob(ctx context.Context, id int64) (*db.ErasureJob, error)
}

// ErrErasureInProgress is returned by Erase when the account is locked
// (sessions revoked, the erasure queued) but not yet finished: the inline
// budget ran out, a stage failed after the lock, or another caller is driving
// the same user. The pending marker and the queued job complete it — the
// maintenance loop at once, the next start-up otherwise — so callers report
// success, exactly as for ErrErasureFilesPending.
var ErrErasureInProgress = errors.New("erasure: in progress")

// WakeCh receives one value per burst of Erase calls that left work for the
// maintenance loop; the loop selects on it beside its ticker and calls
// Resume. The channel holds one value: a wake while one is pending is the
// same wake.
func (s *ErasureService) WakeCh() <-chan struct{} {
	return s.wake
}

// RequestResume asks the maintenance loop to run Resume now rather than at
// its next tick. Never blocks.
func (s *ErasureService) RequestResume() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// claim marks userID as being driven and reports whether the caller got it.
func (s *ErasureService) claim(userID int64) bool {
	s.inFlightMu.Lock()
	defer s.inFlightMu.Unlock()
	if _, busy := s.inFlight[userID]; busy {
		return false
	}
	s.inFlight[userID] = struct{}{}
	return true
}

func (s *ErasureService) release(userID int64) {
	s.inFlightMu.Lock()
	defer s.inFlightMu.Unlock()
	delete(s.inFlight, userID)
}

// Erase erases userID in three stages (db.EraseAccountLock, Drain, Finish),
// then this job's files. Errors from the lock stage are the store's
// (db.ErrLastAdmin, db.ErrNotFound) and mean nothing changed. From the lock
// on the erasure is committed to and every outcome but ErrErasureFilesPending
// and ErrErasureInProgress is success: both mean the account is gone or on
// its way out and the journal finishes the rest. Logs the id only, never a
// name.
func (s *ErasureService) Erase(ctx context.Context, userID int64) error {
	if !s.claim(userID) {
		return fmt.Errorf("%w: user %d is already being erased", ErrErasureInProgress, userID)
	}
	// One defer, in this order: release the claim, then wake. A wake sent
	// while the claim is still held can be taken by the maintenance loop,
	// which then skips the user and leaves the job to the next tick.
	wake := false
	defer func() {
		s.release(userID)
		if wake {
			s.RequestResume()
		}
	}()

	// The marker goes down first, pending, so a crash between the lock and
	// the marker cannot leave an erasure that a restore could undo. A
	// pending marker is applied on the next open whether or not the
	// transaction committed (MarkerStore.ReplayAccounts — a restore reverts
	// a commit, so the main database cannot say), which is why the
	// refusals run before it is written: a refused erasure must leave no
	// marker a crash could turn into an erasure. The users sequence goes
	// down with it, the floor below which no id is handed out again.
	var token string
	created := false
	if s.markers != nil {
		if err := s.st.EraseAccountPreflight(ctx, userID); err != nil {
			return err
		}
		seq, err := s.st.SequenceValue(ctx, db.SequenceFloorUsers)
		if err != nil {
			return fmt.Errorf("erasure: sequence: %w", err)
		}
		token, created, err = s.markers.RecordPendingAccount(ctx, userID, seq)
		if err != nil {
			return fmt.Errorf("erasure: marker: %w", err)
		}
	}
	if err := s.lockBehindBarrier(ctx, userID); err != nil {
		// Before the lock committed: nothing changed.
		if created {
			if dErr := s.markers.DiscardPending(context.WithoutCancel(ctx), token); dErr != nil {
				slog.Error("erasure: could not discard the pending marker", "user_id", userID, "err", dErr)
			}
		}
		return err
	}

	// The point of no return. The rest outlives the request that started it,
	// and a failure from here on keeps the marker pending: it must not reach
	// DiscardPending, and the account is already unusable.
	bg := context.WithoutCancel(ctx)
	if s.hub != nil {
		s.hub.DisconnectRevokedUser(userID)
	}
	// A send that was in flight at the lock may have queued a badge
	// increment the first flush did not see.
	if s.flushMentions != nil {
		s.flushMentions(bg)
	}
	job, err := s.driveToFinish(bg, userID, token, time.Now().Add(eraseInlineBudget))
	if err != nil {
		if !errors.Is(err, ErrErasureInProgress) {
			slog.Warn("erasure: a stage failed after the lock; the maintenance loop finishes the erasure", "user_id", userID, "err", err)
			err = fmt.Errorf("%w: user %d: %w", ErrErasureInProgress, userID, err)
		}
		wake = true
		return err
	}
	s.confirmMarker(bg, userID, token)
	return s.finishErasure(ctx, userID, job)
}

// lockBehindBarrier is the lock stage behind the audit and mention barrier
// (eraseBehindBarrier's reasoning): everything the audit writer holds is on
// disk first, with its ids, so an entry about the subject queued before the
// finish transaction is rewritten by its UPDATE.
func (s *ErasureService) lockBehindBarrier(ctx context.Context, userID int64) error {
	if err := s.barrier(ctx); err != nil {
		return err
	}
	if _, err := s.st.EraseAccountLock(ctx, userID, true); err != nil {
		return err
	}
	return nil
}

// driveToFinish runs the drain stage until deadline (zero: no limit) and then
// the finish stage. ErrErasureInProgress means the deadline came first.
func (s *ErasureService) driveToFinish(ctx context.Context, userID int64, token string, deadline time.Time) (*db.ErasureJob, error) {
	done, err := s.st.EraseAccountDrain(ctx, userID, deadline)
	if err != nil {
		return nil, fmt.Errorf("erasure: drain: %w", err)
	}
	if !done {
		return nil, ErrErasureInProgress
	}
	job, err := s.st.EraseAccountFinish(ctx, userID, token)
	if err != nil {
		return nil, fmt.Errorf("erasure: finish: %w", err)
	}
	return job, nil
}

// confirmMarker records the erasure the pending marker stood for.
func (s *ErasureService) confirmMarker(ctx context.Context, userID int64, token string) {
	if s.markers == nil {
		return
	}
	if err := s.markers.ConfirmAccount(ctx, token); err != nil {
		// The account is gone; a pending marker is applied on the next
		// open either way, so this is loud but not fatal.
		slog.Error("erasure: could not confirm the marker", "user_id", userID, "err", err)
	}
}

// Resume runs every unfinished job once and reports how many are now done.
// A queued job is first driven through drain and finish (no guard: it passed
// at the lock, and no time limit: this is the maintenance loop), then its
// files go like any other job's. A job whose files still fail to go stays
// for the next call.
//
// It also pays any WAL checkpoint an erasure owes. That debt is
// not a job: the erasure's rows and files are gone either way, and what is
// left is frames holding the erased bytes still sitting in the -wal because
// the checkpoint behind the commit came back blocked. Nothing else would run
// TRUNCATE again — SQLite's autocheckpoint is PASSIVE and never truncates the
// log — so the erasure would leave those bytes on disk indefinitely.
func (s *ErasureService) Resume(ctx context.Context) (int, error) {
	jobs, err := s.st.ListUnfinishedErasureJobs(ctx)
	if err != nil {
		return 0, err
	}
	done := 0
	var firstErr error
	for i := range jobs {
		finished := true
		var err error
		if jobs[i].State == db.ErasureStateQueued {
			finished, err = s.resumeQueued(ctx, &jobs[i])
		} else {
			err = s.runJob(ctx, &jobs[i])
		}
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if finished {
			done++
		}
	}
	// Best effort, and after the jobs above so the frames they wrote are under
	// the same TRUNCATE. Both outcomes are already reported where they happen
	// and a debt that stays unpaid keeps its flag set, so the next tick tries
	// again: a blocked checkpoint is not this tick's failure.
	_, _ = s.st.FinishOwedErasureCheckpoint(ctx)
	return done, firstErr
}

// resumeQueued finishes a queued job. It reports false, with no error, when
// somebody else is driving the user or already finished the job.
func (s *ErasureService) resumeQueued(ctx context.Context, job *db.ErasureJob) (bool, error) {
	if !s.claim(job.UserID) {
		// No wake here: Erase wakes the loop after it releases the claim
		// when it leaves the job queued, and a wake now would only spin.
		return false, nil
	}
	defer s.release(job.UserID)
	// The listing is older than the claim: the request that held it may have
	// finished the job in between.
	cur, err := s.st.GetErasureJob(ctx, job.ID)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("erasure: resume job %d: %w", job.ID, err)
	}
	if cur.State != db.ErasureStateQueued {
		return false, nil
	}
	token := s.SubjectToken(job.UserID)
	finished, err := s.driveToFinish(ctx, job.UserID, token, time.Time{})
	if err != nil {
		return false, err
	}
	bg := context.WithoutCancel(ctx)
	s.confirmMarker(bg, job.UserID, token)
	if err := s.finishErasure(bg, job.UserID, finished); err != nil {
		return false, err
	}
	return true, nil
}
