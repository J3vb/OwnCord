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

// FileRemover removes one stored blob by its stored_as name; a missing file is
// not an error for the runner. *storage.Storage satisfies it.
type FileRemover interface {
	Delete(name string) error
}

// StorageLister lists the upload directory for reconciliation.
type StorageLister interface {
	List() ([]storage.Entry, error)
}

// ErasureHub is the runner's slice of the hub: the member_ban that drops the
// erased user from every client and closes their socket, and the replay purge
// after it. *ws.Hub satisfies it.
type ErasureHub interface {
	BroadcastMemberBan(userID int64)
	PurgeUserFromReplay(ctx context.Context, userID int64) error
	// DisconnectRevokedUser drops the live socket right after the lock stage revoked
	// sessions, so a half-erased account is not left connected during the drain.
	DisconnectRevokedUser(userID int64)
}

// ErasureStore is the slice of Store the erasure runner needs.
type ErasureStore interface {
	db.Auditor
	db.EntryAuditor
	ErasureStageStore
	EraseAccountPreflight(ctx context.Context, userID int64) error
	ReplayEraseAccount(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	FlushAudits(ctx context.Context) error
	CountAdminClassAccounts(ctx context.Context) (int, error)
	CloseSetupGate(ctx context.Context) error
	SequenceValue(ctx context.Context, table string) (int64, error)
	RaiseSequences(ctx context.Context, floors map[string]int64) error
	ListUserIDs(ctx context.Context) ([]int64, error)
	ListUnfinishedErasureJobs(ctx context.Context) ([]db.ErasureJob, error)
	// FinishOwedErasureCheckpoint finishes a wal_checkpoint(TRUNCATE) an erasure
	// could not, when owed. The maintenance tick keeps the erasure log line's promise;
	// SQLite's autocheckpoint copies frames but never truncates the log.
	FinishOwedErasureCheckpoint(ctx context.Context) (bool, error)
	RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error
	CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error
	MarkErasureJobReplayPurged(ctx context.Context, id int64) error
	DeleteEventsForUser(ctx context.Context, userID int64) (int64, error)
	ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error)
}

// ErrErasureFilesPending is returned by Erase when the database half committed
// but some files remain on disk: the job row lists them and Resume finishes. The
// account is gone either way, so callers report success.
var ErrErasureFilesPending = errors.New("erasure: files pending")

// ErasureService owns account erasure end to end: db.EraseAccount's transaction,
// then removal of the files it journaled (resumed at startup and each
// maintenance tick until done), plus the reconciliation pass reclaiming files the
// upload directory holds without a row. Self-service (AuthService.DeleteAccount)
// and the admin route (ModerationService.EraseUser) both run through here.
type ErasureService struct {
	// mu serialises the file half: a request finishing its job and a tick resuming
	// every unfinished one must not race on the attempt bookkeeping. Removal itself
	// is idempotent.
	mu      syncutil.Mutex
	st      ErasureStore
	files   FileRemover
	hub     ErasureHub
	markers *db.MarkerStore
	// flushMentions applies queued mention-badge increments before the erasure
	// transaction's reversal and message deletion (it cannot cheaply name the ids, so
	// it flushes everything). Wired by service.New; nil means no worker.
	flushMentions func(ctx context.Context)
	// floorProbeCeiling bounds the sequence-floor probe; tests lower it to reach the
	// refusal cheaply.
	floorProbeCeiling int64
	// inFlightMu guards inFlight, the users an Erase or Resume is driving, so a
	// request and the maintenance loop never drive one user at once
	// (erasure_resume.go). A leaf lock: never held across I/O or while mu is held.
	inFlightMu syncutil.Mutex
	inFlight   map[int64]struct{}
	// wake carries one pending request (buffered, size one) for the maintenance loop
	// to resume jobs now instead of at the next tick.
	wake chan struct{}
}

// NewErasureService wires the runner over st. Files are removed only once
// SetFiles installs the upload storage; until then jobs stay db_done and resume
// later.
func NewErasureService(st ErasureStore) *ErasureService {
	return &ErasureService{
		st: st, floorProbeCeiling: db.SequenceFloorProbeCeiling,
		inFlight: map[int64]struct{}{}, wake: make(chan struct{}, 1),
	}
}

// SetFiles installs the file remover. Call it at the composition root before
// serving; not synchronised against a concurrent Erase.
func (s *ErasureService) SetFiles(f FileRemover) {
	s.files = f
}

// HasFiles reports whether a file remover is installed.
func (s *ErasureService) HasFiles() bool {
	return s.files != nil
}

// SetHub installs the hub: Erase then broadcasts the member_ban itself right
// after the transaction and purges the replay pipeline. Call it before serving.
func (s *ErasureService) SetHub(h ErasureHub) {
	s.hub = h
}

// SetMarkers installs the deletion-marker store: every erasure records a marker
// and ReplayMarkers erases again whatever a restored backup brought back. Without
// one, erasures record nothing and audit rows unlink without a token.
func (s *ErasureService) SetMarkers(m *db.MarkerStore) {
	s.markers = m
}

// SubjectToken is the deletion-marker token for userID, or "" without a marker
// store; the erasure's audit rows carry it instead of the id.
func (s *ErasureService) SubjectToken(userID int64) string {
	if s.markers == nil {
		return ""
	}
	return s.markers.SubjectToken(userID)
}

// BroadcastsMemberBan reports whether Erase sends the member_ban itself; a
// caller without a hub here sends its own.
func (s *ErasureService) BroadcastsMemberBan() bool {
	return s.hub != nil
}

// eraseBehindBarrier runs one erasure transaction behind the audit writer's
// barrier (db.FlushAudits): everything the writer holds is on disk first with its
// ids, so an entry about the subject queued earlier is rewritten by the
// transaction's UPDATE (and left as it was if refused). An entry enqueued after
// the barrier is written unlinked by the rule the transaction installs on commit
// (db.eraseAccount, AuditWriter.Unlink).
func (s *ErasureService) eraseBehindBarrier(ctx context.Context, userID int64, token string, erase func(context.Context, int64, string) (*db.ErasureJob, error)) (*db.ErasureJob, error) {
	if err := s.barrier(ctx); err != nil {
		return nil, err
	}
	return erase(ctx, userID, token)
}

// barrier is the flush-before-erase step shared by the live lock and marker replay.
func (s *ErasureService) barrier(ctx context.Context) error {
	// Flush queued mention-badge increments first, so a message sent inside the
	// coalesce window has its increment on disk and the reversal takes exactly it
	// back (see MessageService.FlushAllPendingMentionCounts).
	if s.flushMentions != nil {
		s.flushMentions(ctx)
	}
	if err := s.st.FlushAudits(ctx); err != nil {
		return fmt.Errorf("erasure: audit barrier: %w", err)
	}
	return nil
}

// eraseForReplay is Erase for a marker replay: the marker is authoritative, so
// it is neither recorded nor discarded; the last-admin guard does not apply
// (db.ReplayEraseAccount: a restored backup from before the admin handover must
// not keep the subject); the audit row names the replay. A replay that leaves no
// admin-class account is the restored backup's state, said loudly.
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
			// The account is gone; the journal finishes the files on a later Resume, as the
			// live routes do. A replay must not abort start-up over a store that is merely
			// down.
			slog.Warn("erasure replay: files pending", "user_id", userID, "err", err)
			return nil
		}
		return err
	}
	return nil
}

// ReplayMarkers applies every deletion marker at startup, before anything
// serves, so a restored backup cannot show an erased account. It first raises the
// id counters to the markers' recorded floors, so a restore that rolled
// sqlite_sequence back cannot hand an erased account's id and token to a new one.
// No marker store means nothing to replay.
func (s *ErasureService) ReplayMarkers(ctx context.Context) (db.ReplayReport, error) {
	if s.markers == nil {
		return db.ReplayReport{}, nil
	}
	floors, err := s.markers.SequenceFloors(ctx)
	if err != nil {
		return db.ReplayReport{}, err
	}
	// A marker file written before floors existed records none, and neither the live
	// counter nor an existing floor row can stand in: this database may be a restore
	// that rolled the counter back below the marker ids, and a later erasure may have
	// written a floor while an older marker names a higher id. Only the markers are a
	// source, so recover the ids from the tokens once, record the probe, and later
	// opens skip it (every later marker records its own floor).
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
	// An account marker proves the installation was set up and an account erased. It
	// lives outside the database, so it is the only evidence left when a backup from
	// before the first owner is restored: that rolls users and the setup flag back
	// together and the replay finds nothing to erase. Closing the gate here keeps the
	// unauthenticated setup endpoint shut across that restore.
	if err := s.closeSetupGateForMarkers(ctx); err != nil {
		return db.ReplayReport{}, err
	}
	return s.markers.ReplayAccounts(ctx, s.st, s.eraseForReplay)
}

// closeSetupGateForMarkers records that the server was set up when the marker
// file says so, whatever the restored database says.
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

// ErrSequenceFloorUnresolved is the refusal when a marker names an id the probe
// cannot reach: no floor below it is safe, and accepting one would let that id be
// handed out again and its innocent holder erased by the old marker later.
// Start-up fails instead. Only the operator knows the id space, so they raise the
// floor and acknowledge it (MarkerStore.MarkFloorProbed, docs/security.md,
// "Erasure marker sequence floors"); the message names both statements.
var ErrSequenceFloorUnresolved = errors.New("erasure markers: no safe sequence floor could be established from the markers")

// recoverSequenceFloor is the floor for a table whose marker file has not been
// probed: the highest id its markers name, or the higher of the recorded floor and
// the live counter. A marker the probe cannot reach is fatal, not logged: a floor
// that is only a lower bound is the defect this recovery closes.
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

// finishErasure is everything after the database half: member_ban and replay
// purge, then the files.
func (s *ErasureService) finishErasure(ctx context.Context, userID int64, job *db.ErasureJob) error {
	slog.Info("account erased", "user_id", userID, "erasure_job", job.ID, "files", len(job.Files))
	// The rest outlives the request: a canceled context must not leave the replay
	// pipeline naming the subject or a half-removed job.
	bg := context.WithoutCancel(ctx)
	if s.hub != nil {
		// Drop the user from every client and close their socket. Purging every frame
		// naming them (the member_ban included) is the job's next step, retried from the
		// journal.
		s.hub.BroadcastMemberBan(userID)
	}
	if err := s.runJob(bg, job); err != nil {
		return fmt.Errorf("%w: job %d: %w", ErrErasureFilesPending, job.ID, err)
	}
	return nil
}

// runJob removes a job's files and marks it done, or records the attempt. A
// missing file counts as removed (a prior attempt or reconciliation took it).
func (s *ErasureService) runJob(ctx context.Context, job *db.ErasureJob) error {
	if job.State == db.ErasureStateQueued {
		// The database half is unfinished (files not all listed, account still there);
		// Resume drives it first.
		return fmt.Errorf("erasure: job %d is still queued", job.ID)
	}
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

// purgeReplay takes the erased user's frames out of the replay pipeline: through
// the hub when installed (ring buffer, persister barrier, events rows, producer
// tombstone), else the persisted rows alone (start-up replay, tests), since
// nothing is buffered yet.
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

// Reconcile removes upload files no database row names (stranded by the orphan
// sweep or a restore). Only files older than cutoff are candidates, so an upload
// whose row is not written yet is left alone, and at most limit go per call.
// Returns how many were removed.
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
