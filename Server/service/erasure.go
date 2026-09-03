package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// FileRemover removes one stored blob by its stored_as name. *storage.Storage
// satisfies it; a missing file is not an error for the erasure runner.
type FileRemover interface {
	Delete(name string) error
}

// StorageLister lists the upload directory for the reconciliation pass.
// *storage.Storage satisfies it.
type StorageLister interface {
	List() ([]storage.Entry, error)
}

// ErasureHub is what the runner needs from the WebSocket hub: the
// member_ban that drops the erased user from every client and closes their
// socket, and the replay purge that follows it. *ws.Hub satisfies it.
type ErasureHub interface {
	BroadcastMemberBan(userID int64)
	PurgeUserFromReplay(ctx context.Context, userID int64) error
}

// ErasureStore is the slice of Store the erasure runner needs.
type ErasureStore interface {
	db.Auditor
	db.EntryAuditor
	EraseAccount(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	ListUserIDs(ctx context.Context) ([]int64, error)
	ListUnfinishedErasureJobs(ctx context.Context) ([]db.ErasureJob, error)
	RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error
	CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error
	MarkErasureJobReplayPurged(ctx context.Context, id int64) error
	DeleteEventsForUser(ctx context.Context, userID int64) (int64, error)
	ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error)
}

// ErrErasureFilesPending is returned by Erase when the database half
// committed but some of the subject's files are still on disk: the job row
// keeps them listed and Resume finishes the removal. The account is gone
// either way, so callers report success and leave the files to the journal.
var ErrErasureFilesPending = errors.New("erasure: files pending")

// ErasureService owns account erasure end to end (B4-9, BPR-052, BG-11):
// db.EraseAccount's transaction, then the removal of the files that
// transaction journaled, resumed at startup and on each maintenance tick
// until every job is done, plus the reconciliation pass that reclaims files
// the upload directory holds without a row (data-lifecycle O3 A3).
//
// Both the self-service route (AuthService.DeleteAccount) and the
// administrator's route (ModerationService.EraseUser) run through here.
type ErasureService struct {
	// mu serialises the file half: a request finishing its own job and a
	// maintenance tick resuming every unfinished one must not race on the
	// attempt bookkeeping. Removal itself is idempotent.
	mu      syncutil.Mutex
	st      ErasureStore
	files   FileRemover
	hub     ErasureHub
	markers *db.MarkerStore
}

// NewErasureService wires the runner over st. Files are removed only once
// SetFiles has installed the upload storage; until then jobs stay db_done
// and are resumed later.
func NewErasureService(st ErasureStore) *ErasureService {
	return &ErasureService{st: st}
}

// SetFiles installs the file remover. Call it at the composition root before
// serving; it is not synchronised against a concurrent Erase.
func (s *ErasureService) SetFiles(f FileRemover) {
	s.files = f
}

// HasFiles reports whether a file remover is installed.
func (s *ErasureService) HasFiles() bool {
	return s.files != nil
}

// SetHub installs the hub: from then on Erase broadcasts the member_ban
// itself, right after the transaction, and purges the replay pipeline
// behind it. Call it at the composition root before serving.
func (s *ErasureService) SetHub(h ErasureHub) {
	s.hub = h
}

// SetMarkers installs the deletion-marker store (B4-10): every erasure
// records a marker there, and ReplayMarkers erases again whatever a
// restored backup brought back. Without one erasures record nothing and
// audit rows unlink without a token.
func (s *ErasureService) SetMarkers(m *db.MarkerStore) {
	s.markers = m
}

// SubjectToken is the deletion-marker token for userID, or "" without a
// marker store — what the erasure's own audit rows carry instead of the id.
func (s *ErasureService) SubjectToken(userID int64) string {
	if s.markers == nil {
		return ""
	}
	return s.markers.SubjectToken(userID)
}

// BroadcastsMemberBan reports whether Erase sends the member_ban itself;
// a caller without a hub here sends its own.
func (s *ErasureService) BroadcastsMemberBan() bool {
	return s.hub != nil
}

// Erase erases userID: the database half, then this job's files. Errors from
// the database half are the store's (db.ErrLastAdmin, db.ErrNotFound) and
// mean nothing changed; ErrErasureFilesPending means the account is gone and
// the journal holds the rest. Logs the id only, never a name.
func (s *ErasureService) Erase(ctx context.Context, userID int64) error {
	// The marker goes down first, pending, so a crash between the commit
	// and the marker cannot leave an erasure that a restore could undo; the
	// next open resolves a pending marker by whether the account still
	// exists (MarkerStore.ReplayAccounts).
	var token string
	created := false
	if s.markers != nil {
		var err error
		token, created, err = s.markers.RecordPendingAccount(ctx, userID)
		if err != nil {
			return fmt.Errorf("erasure: marker: %w", err)
		}
	}
	job, err := s.st.EraseAccount(ctx, userID, token)
	if err != nil {
		if created {
			if dErr := s.markers.DiscardPending(context.WithoutCancel(ctx), token); dErr != nil {
				slog.Error("erasure: could not discard the pending marker", "user_id", userID, "err", dErr)
			}
		}
		return err
	}
	if s.markers != nil {
		if cErr := s.markers.ConfirmAccount(context.WithoutCancel(ctx), token); cErr != nil {
			// The account is gone; a pending marker is confirmed on the next
			// open by that very fact, so this is loud but not fatal.
			slog.Error("erasure: could not confirm the marker", "user_id", userID, "err", cErr)
		}
	}
	return s.finishErasure(ctx, userID, job)
}

// eraseForReplay is Erase for a marker replay: the marker already exists,
// so it is neither recorded nor discarded, and the audit row names the
// replay.
func (s *ErasureService) eraseForReplay(ctx context.Context, userID int64, token string) error {
	job, err := s.st.EraseAccount(ctx, userID, token)
	if err != nil {
		return err
	}
	db.WriteAuditEntry(context.WithoutCancel(ctx), s.st, db.AuditEntry{
		Action: "account_erasure_replayed", TargetType: "user", Detail: "erased again after a restore", SubjectToken: token,
	})
	return s.finishErasure(ctx, userID, job)
}

// ReplayMarkers applies every recorded deletion marker to the database —
// at startup, before anything serves, so a restored backup cannot show an
// erased account (data-lifecycle O4 A5). No marker store means nothing to
// replay.
func (s *ErasureService) ReplayMarkers(ctx context.Context) (db.ReplayReport, error) {
	if s.markers == nil {
		return db.ReplayReport{}, nil
	}
	return s.markers.ReplayAccounts(ctx, s.st, s.eraseForReplay)
}

// finishErasure is everything after the database half: the member_ban and
// replay purge, then the files.
func (s *ErasureService) finishErasure(ctx context.Context, userID int64, job *db.ErasureJob) error {
	slog.Info("account erased", "user_id", userID, "erasure_job", job.ID, "files", len(job.Files))
	// The rest outlives the request that started it: a cancelled context
	// must not leave the replay pipeline naming the subject or a
	// half-removed job for the next tick when the process is right here.
	bg := context.WithoutCancel(ctx)
	if s.hub != nil {
		// Drop the user from every client and close their socket. The purge
		// of every frame naming them — the member_ban included — is the
		// job's next step, retried from the journal until it succeeds.
		s.hub.BroadcastMemberBan(userID)
	}
	if err := s.runJob(bg, job); err != nil {
		return fmt.Errorf("%w: job %d: %w", ErrErasureFilesPending, job.ID, err)
	}
	return nil
}

// Resume runs every unfinished job once and reports how many are now done.
// A job whose files still fail to go stays for the next call.
func (s *ErasureService) Resume(ctx context.Context) (int, error) {
	jobs, err := s.st.ListUnfinishedErasureJobs(ctx)
	if err != nil {
		return 0, err
	}
	done := 0
	var firstErr error
	for i := range jobs {
		if err := s.runJob(ctx, &jobs[i]); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		done++
	}
	return done, firstErr
}

// runJob removes a job's files and marks it done, or records the attempt.
// A missing file counts as removed — the previous attempt, or the
// reconciliation pass, already took it.
func (s *ErasureService) runJob(ctx context.Context, job *db.ErasureJob) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !job.ReplayPurged {
		if err := s.purgeReplay(ctx, job.UserID); err != nil {
			slog.Warn("erasure: replay purge failed", "erasure_job", job.ID, "user_id", job.UserID, "err", err)
			if recErr := s.st.RecordErasureJobAttempt(ctx, job.ID, job.FilesRemoved, err.Error()); recErr != nil {
				return recErr
			}
			return err
		}
		if err := s.st.MarkErasureJobReplayPurged(ctx, job.ID); err != nil {
			return err
		}
		job.ReplayPurged = true
	}
	if job.State == db.ErasureStateDone {
		// Only the purge was outstanding.
		return nil
	}
	if s.files == nil {
		if len(job.Files) == 0 {
			return s.finish(ctx, job, 0)
		}
		err := errors.New("no file storage configured")
		if recErr := s.st.RecordErasureJobAttempt(ctx, job.ID, 0, err.Error()); recErr != nil {
			return recErr
		}
		return err
	}
	removed := 0
	var lastErr error
	for _, name := range job.Files {
		err := s.files.Delete(name)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			lastErr = fmt.Errorf("remove %s: %w", name, err)
			slog.Warn("erasure: file removal failed", "erasure_job", job.ID, "user_id", job.UserID, "err", err)
			continue
		}
		removed++
	}
	if lastErr != nil {
		if recErr := s.st.RecordErasureJobAttempt(ctx, job.ID, removed, lastErr.Error()); recErr != nil {
			return recErr
		}
		return lastErr
	}
	return s.finish(ctx, job, removed)
}

// purgeReplay takes the erased user's frames out of the replay pipeline:
// through the hub when one is installed (ring buffer, persister barrier,
// events rows, the producer tombstone); without one — the start-up replay,
// a test — the persisted rows alone, since nothing is buffered yet.
func (s *ErasureService) purgeReplay(ctx context.Context, userID int64) error {
	if s.hub != nil {
		return s.hub.PurgeUserFromReplay(ctx, userID)
	}
	_, err := s.st.DeleteEventsForUser(ctx, userID)
	return err
}

func (s *ErasureService) finish(ctx context.Context, job *db.ErasureJob, removed int) error {
	if err := s.st.CompleteErasureJob(ctx, job.ID, removed); err != nil {
		return err
	}
	job.State = db.ErasureStateDone
	job.FilesRemoved = removed
	slog.Info("erasure complete", "erasure_job", job.ID, "user_id", job.UserID, "files_removed", removed)
	return nil
}

// Reconcile removes files from the upload directory that no database row
// names — the stranded class the orphan sweep can produce (O3 A1, HP-4 drill
// D5) and what a restore leaves behind (O3 A5). Only files older than cutoff
// are candidates, so an upload whose row is not written yet is left alone,
// and at most limit files go per call, so a tick stays bounded. Returns how
// many were removed.
func (s *ErasureService) Reconcile(ctx context.Context, lister StorageLister, cutoff time.Time, limit int) (int, error) {
	if s.files == nil || lister == nil || limit <= 0 {
		return 0, nil
	}
	entries, err := lister.List()
	if err != nil {
		return 0, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.ModTime.Before(cutoff) {
			names = append(names, e.Name)
		}
	}
	if len(names) == 0 {
		return 0, nil
	}
	referenced, err := s.st.ReferencedStoredFiles(ctx, names)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, name := range names {
		if referenced[name] {
			continue
		}
		if err := s.files.Delete(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("erasure: reconciliation could not remove a stranded file", "err", err)
			continue
		}
		removed++
		if removed >= limit {
			break
		}
	}
	if removed > 0 {
		slog.Info("erasure: reconciliation removed stranded files", "count", removed)
	}
	return removed, nil
}
