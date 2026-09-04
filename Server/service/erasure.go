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
	EraseAccountPreflight(ctx context.Context, userID int64) error
	ReplayEraseAccount(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	FlushAudits(ctx context.Context) error
	CountAdminClassAccounts(ctx context.Context) (int, error)
	CloseSetupGate(ctx context.Context) error
	SequenceValue(ctx context.Context, table string) (int64, error)
	RaiseSequences(ctx context.Context, floors map[string]int64) error
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
	// floorProbeCeiling bounds the sequence-floor probe; production runs at
	// db.SequenceFloorProbeCeiling and the tests lower it to reach the
	// refusal without hashing their way to it.
	floorProbeCeiling int64
}

// NewErasureService wires the runner over st. Files are removed only once
// SetFiles has installed the upload storage; until then jobs stay db_done
// and are resumed later.
func NewErasureService(st ErasureStore) *ErasureService {
	return &ErasureService{st: st, floorProbeCeiling: db.SequenceFloorProbeCeiling}
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
	// and the marker cannot leave an erasure that a restore could undo. A
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
	job, err := s.eraseBehindBarrier(ctx, userID, token, s.st.EraseAccount)
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
			// The account is gone; a pending marker is applied on the next
			// open either way, so this is loud but not fatal.
			slog.Error("erasure: could not confirm the marker", "user_id", userID, "err", cErr)
		}
	}
	return s.finishErasure(ctx, userID, job)
}

// eraseBehindBarrier runs one erasure transaction behind the audit
// writer's barrier (db.FlushAudits): everything the writer holds is on
// disk first, with its ids, so an entry about the subject queued before
// the transaction is rewritten by the transaction's UPDATE, and a refused
// transaction leaves it as it was. An entry enqueued after the barrier is
// written unlinked by the rule the transaction installs on commit
// (db.eraseAccount, AuditWriter.Unlink), read under the writer connection
// at insert time.
func (s *ErasureService) eraseBehindBarrier(ctx context.Context, userID int64, token string, erase func(context.Context, int64, string) (*db.ErasureJob, error)) (*db.ErasureJob, error) {
	if err := s.st.FlushAudits(ctx); err != nil {
		return nil, fmt.Errorf("erasure: audit barrier: %w", err)
	}
	return erase(ctx, userID, token)
}

// eraseForReplay is Erase for a marker replay: the marker already exists
// and is authoritative, so it is neither recorded nor discarded; the
// last-admin guard does not apply (db.ReplayEraseAccount: the erasure
// passed it when it ran, and a restored backup from before the admin
// handover must not keep the subject); the audit row names the replay. A
// replay that leaves no admin-class account is the restored backup's
// state, said loudly: the copy predates the handover.
func (s *ErasureService) eraseForReplay(ctx context.Context, userID int64, token string) error {
	job, err := s.eraseBehindBarrier(ctx, userID, token, s.st.ReplayEraseAccount)
	if err != nil {
		return err
	}
	db.WriteAuditEntry(context.WithoutCancel(ctx), s.st, db.AuditEntry{
		Action: "account_erasure_replayed", TargetType: "user", Detail: "erased again after a restore", SubjectToken: token,
	})
	if n, cErr := s.st.CountAdminClassAccounts(ctx); cErr != nil {
		slog.Warn("erasure replay: could not count the remaining admin-class accounts", "err", cErr)
	} else if n == 0 {
		slog.Error("erasure replay: the erased account was the last admin-class account in the restored database — the backup predates the handover to another administrator; none remains", "user_id", userID)
	}
	if err := s.finishErasure(ctx, userID, job); err != nil {
		if errors.Is(err, ErrErasureFilesPending) {
			// The account is gone from the database; the journal finishes
			// the files on a later Resume, same as the live routes
			// (DeleteAccount, EraseUser). A replay must not abort start-up
			// over a store that is merely down right now.
			slog.Warn("erasure replay: files pending", "user_id", userID, "err", err)
			return nil
		}
		return err
	}
	return nil
}

// ReplayMarkers applies every deletion marker to the database — at
// startup, before anything serves, so a restored backup cannot show an
// erased account (data-lifecycle O4 A5) — after raising the id counters to
// the floors the markers recorded, so a restore that rolled sqlite_sequence
// back cannot hand an erased account's id, and its token, to a new one. No
// marker store means nothing to replay.
func (s *ErasureService) ReplayMarkers(ctx context.Context) (db.ReplayReport, error) {
	if s.markers == nil {
		return db.ReplayReport{}, nil
	}
	floors, err := s.markers.SequenceFloors(ctx)
	if err != nil {
		return db.ReplayReport{}, err
	}
	// A marker file written before the floors existed records none, and
	// neither the live counter nor a floor row already present can stand in
	// for them: this database may be a restore, which rolls the counter back
	// below the ids the markers name — the case the floors defend against —
	// and a floor row may have been written by a later erasure while an
	// older marker still names a higher id. The markers are the only source,
	// so the ids they name are recovered from the tokens themselves once;
	// the probe is then recorded and later opens skip it, every marker
	// written after it having recorded its own floor.
	for _, table := range []string{db.SequenceFloorUsers, db.SequenceFloorChannels} {
		probed, err := s.markers.FloorProbed(ctx, table)
		if err != nil {
			return db.ReplayReport{}, err
		}
		if probed {
			continue
		}
		floor, err := s.recoverSequenceFloor(ctx, table, floors[table])
		if err != nil {
			return db.ReplayReport{}, err
		}
		if err := s.markers.RaiseSequenceFloor(ctx, table, floor); err != nil {
			return db.ReplayReport{}, err
		}
		if err := s.markers.MarkFloorProbed(ctx, table); err != nil {
			return db.ReplayReport{}, err
		}
		floors[table] = floor
	}
	if err := s.st.RaiseSequences(ctx, floors); err != nil {
		return db.ReplayReport{}, fmt.Errorf("erasure: sequence floors: %w", err)
	}
	// An account marker proves this installation was set up and an account
	// erased. It lives outside the database, so it is the only evidence left
	// when a backup taken before the first owner is restored: that rolls the
	// users table and the setup flag back to their fresh state together, and
	// the replay itself finds nothing to erase, since the marked account is
	// absent. Closing the gate from here is what keeps the unauthenticated
	// setup endpoint shut across that restore.
	if err := s.closeSetupGateForMarkers(ctx); err != nil {
		return db.ReplayReport{}, err
	}
	return s.markers.ReplayAccounts(ctx, s.st, s.eraseForReplay)
}

// closeSetupGateForMarkers records that the server was set up when the
// marker file says so, whatever the restored database says.
func (s *ErasureService) closeSetupGateForMarkers(ctx context.Context) error {
	marked, err := s.markers.HasAccountMarkers(ctx)
	if err != nil {
		return err
	}
	if !marked {
		return nil
	}
	if err := s.st.CloseSetupGate(ctx); err != nil {
		return fmt.Errorf("erasure: setup gate: %w", err)
	}
	return nil
}

// ErrSequenceFloorUnresolved is the refusal when a marker names an id the
// probe cannot reach: no floor below it is safe, and accepting one would
// leave that id free to be handed out again and its innocent holder erased
// by the old marker on a later open. Start-up fails on it instead. The way
// out is the operator's, because only they know the id space their markers
// came from: they raise the floor and acknowledge it, which settles the
// table and lets the next start-up through (MarkerStore.MarkFloorProbed,
// docs/security.md, "Erasure marker sequence floors"). The message names
// both statements.
var ErrSequenceFloorUnresolved = errors.New("erasure markers: no safe sequence floor could be established from the markers")

// recoverSequenceFloor is the floor for a table whose marker file has not
// been probed: the highest id its markers name, or whichever of the
// recorded floor and the live counter stands higher. A marker the probe
// cannot reach is fatal rather than logged — a floor that is only a lower
// bound is the defect this recovery exists to close.
func (s *ErasureService) recoverSequenceFloor(ctx context.Context, table string, recorded int64) (int64, error) {
	located, complete, err := s.markers.LocateSequenceFloor(ctx, table, s.floorProbeCeiling)
	if err != nil {
		return 0, fmt.Errorf("erasure: sequence floors: %w", err)
	}
	if !complete {
		slog.Error("erasure markers: a marker names an id beyond the probe ceiling, so no safe sequence floor can be established; set the floor above the highest id this installation ever handed out and acknowledge it, in the marker file (docs/security.md, \"Erasure marker sequence floors\")",
			"table", table, "located_up_to", located, "ceiling", s.floorProbeCeiling,
			"marker_file", s.markers.Path(),
			"set_floor", fmt.Sprintf("INSERT INTO sequence_floors (name, seq) VALUES ('%s', <highest id ever handed out>) ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq);", table),
			"acknowledge", fmt.Sprintf("INSERT OR IGNORE INTO floor_probes (name) VALUES ('%s');", table))
		return 0, fmt.Errorf("%w: %s", ErrSequenceFloorUnresolved, table)
	}
	seq, err := s.st.SequenceValue(ctx, table)
	if err != nil {
		return 0, fmt.Errorf("erasure: sequence floors: %w", err)
	}
	return max(located, max(recorded, seq)), nil
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
