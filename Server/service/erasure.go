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

// FileRemover removes one stored blob by its stored_as name; a missing file is not an error for the runner.
type FileRemover interface {
	Delete(name string) error
}

// StorageLister lists the upload directory for reconciliation.
type StorageLister interface {
	List() ([]storage.Entry, error)
}

// ErasureHub is the runner's slice of the hub: the member_ban that drops the erased user
// from every client and closes their socket, and the replay purge after it.
type ErasureHub interface {
	BroadcastMemberBan(userID int64)
	PurgeUserFromReplay(ctx context.Context, userID int64) error
	// PurgeErasedMessagesFromReplay drops the frames about the messages the erasure deleted:
	// an edit frame names its message, not its author.
	PurgeErasedMessagesFromReplay(ctx context.Context, jobID int64) error
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
	// FinishOwedErasureCheckpoint finishes a wal_checkpoint(TRUNCATE) an erasure could not,
	// when owed; SQLite's autocheckpoint never truncates the log.
	FinishOwedErasureCheckpoint(ctx context.Context) (bool, error)
	RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error
	CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error
	MarkErasureJobReplayPurged(ctx context.Context, id int64) error
	DeleteEventsForUser(ctx context.Context, userID int64) (int64, error)
	DeleteOrphanMessageEvents(ctx context.Context, jobID int64) ([]int64, error)
	ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error)
}

// ErrErasureFilesPending is returned by Erase when the database half committed but some
// files remain: the job row lists them and Resume finishes. The account is gone, so callers report success.
var ErrErasureFilesPending = errors.New("erasure: files pending")

// ErasureService owns account erasure end to end: db.EraseAccount's transaction, removal
// of the files it journaled (resumed at startup and each maintenance tick), and the
// reconciliation pass for files the upload directory holds without a row.
type ErasureService struct {
	// mu serialises the file half: a request finishing its job and a tick resuming every
	// unfinished one must not race on the attempt bookkeeping. Removal is idempotent.
	mu      syncutil.Mutex
	st      ErasureStore
	files   FileRemover
	hub     ErasureHub
	markers *db.MarkerStore
	// flushMentions applies queued mention-badge increments before the erasure transaction's
	// reversal and message deletion (it flushes everything). Wired by service.New; nil means no worker.
	flushMentions func(ctx context.Context)
	// floorProbeCeiling bounds the sequence-floor probe; tests lower it.
	floorProbeCeiling int64
	// inFlightMu guards inFlight, the users an Erase or Resume is driving, so a request and
	// the maintenance loop never drive one user at once. A leaf lock: never held across I/O
	// or while mu is held.
	inFlightMu syncutil.Mutex
	inFlight   map[int64]struct{}
	// wake carries one pending request (buffered, size one) so the loop resumes jobs now, not at the next tick.
	wake chan struct{}
}

// NewErasureService wires the runner over st. Files are removed only once SetFiles
// installs the upload storage; until then jobs stay db_done and resume later.
func NewErasureService(st ErasureStore) *ErasureService {
	return &ErasureService{
		st: st, floorProbeCeiling: db.SequenceFloorProbeCeiling,
		inFlight: map[int64]struct{}{}, wake: make(chan struct{}, 1),
	}
}

// SetFiles installs the file remover; call at the composition root before serving.
func (s *ErasureService) SetFiles(f FileRemover) {
	s.files = f
}

// HasFiles reports whether a file remover is installed.
func (s *ErasureService) HasFiles() bool {
	return s.files != nil
}

// SetHub installs the hub: Erase then broadcasts the member_ban itself right after the
// transaction and purges the replay pipeline. Call before serving.
func (s *ErasureService) SetHub(h ErasureHub) {
	s.hub = h
}

// SetMarkers installs the deletion-marker store: every erasure records a marker and
// ReplayMarkers erases again whatever a restored backup brought back. Without one,
// erasures record nothing and audit rows unlink without a token.
func (s *ErasureService) SetMarkers(m *db.MarkerStore) {
	s.markers = m
}

// SubjectToken is the deletion-marker token for userID, or "" without a marker store; the
// erasure's audit rows carry it instead of the id.
func (s *ErasureService) SubjectToken(userID int64) string {
	if s.markers == nil {
		return ""
	}
	return s.markers.SubjectToken(userID)
}

// BroadcastsMemberBan reports whether Erase sends the member_ban itself (a hub is installed).
func (s *ErasureService) BroadcastsMemberBan() bool {
	return s.hub != nil
}

// eraseBehindBarrier runs one erasure transaction behind the audit writer's barrier
// (db.FlushAudits): everything the writer holds is on disk first, so an earlier entry
// about the subject is rewritten by the transaction's UPDATE; a later one is written
// unlinked by the rule the transaction installs (db.eraseAccount, AuditWriter.Unlink).
func (s *ErasureService) eraseBehindBarrier(ctx context.Context, userID int64, token string, erase func(context.Context, int64, string) (*db.ErasureJob, error)) (*db.ErasureJob, error) {
	if err := s.barrier(ctx); err != nil {
		return nil, err
	}
	return erase(ctx, userID, token)
}

func (s *ErasureService) barrier(ctx context.Context) error {
	// Flush queued mention-badge increments first, so a message sent inside the coalesce
	// window has its increment on disk and the reversal takes exactly it back.
	if s.flushMentions != nil {
		s.flushMentions(ctx)
	}
	if err := s.st.FlushAudits(ctx); err != nil {
		return fmt.Errorf("erasure: audit barrier: %w", err)
	}
	return nil
}

// eraseForReplay is Erase for a marker replay: the marker is authoritative (neither
// recorded nor discarded); the last-admin guard does not apply (a restored pre-handover
// backup must not keep the subject); the audit row names the replay. A replay leaving no
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
			// The account is gone; the journal finishes the files on a later Resume. A replay must
			// not abort start-up over a store that is merely down.
			slog.Warn("erasure replay: files pending", "user_id", userID, "err", err)
			return nil
		}
		return err
	}
	return nil
}

// ReplayMarkers applies every deletion marker at startup, before anything serves, so a
// restored backup cannot show an erased account. It first raises the id counters to the
// markers' recorded floors, so a rolled-back sqlite_sequence cannot hand an erased
// account's id and token to a new one.
func (s *ErasureService) ReplayMarkers(ctx context.Context) (db.ReplayReport, error) {
	if s.markers == nil {
		return db.ReplayReport{}, nil
	}
	floors, err := s.markers.SequenceFloors(ctx)
	if err != nil {
		return db.ReplayReport{}, err
	}
	// A marker file written before floors existed records none, and neither the live counter
	// nor an existing floor row can stand in (a restore may have rolled the counter below the
	// marker ids). Only the markers are a source: recover ids from the tokens once, record
	// the probe, and later opens skip it.
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
	// An account marker proves the installation was set up and an account erased. It lives
	// outside the database, so it is the only evidence left when a pre-first-owner backup is
	// restored; closing the gate keeps the unauthenticated setup endpoint shut across that restore.
	if err := s.closeSetupGateForMarkers(ctx); err != nil {
		return db.ReplayReport{}, err
	}
	return s.markers.ReplayAccounts(ctx, s.st, s.eraseForReplay)
}

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

// ErrSequenceFloorUnresolved means a marker names an id the probe cannot reach, so no floor
// below it is safe (the id could be handed out again and its innocent holder erased by
// the old marker). Start-up fails; the operator raises the floor and acknowledges it
// (MarkerStore.MarkFloorProbed, docs/security.md, "Erasure marker sequence floors").
var ErrSequenceFloorUnresolved = errors.New("erasure markers: no safe sequence floor could be established from the markers")

// recoverSequenceFloor is the floor for an unprobed table: the highest id its markers
// name, or the higher of the recorded floor and the live counter. A marker the probe
// cannot reach is fatal: a floor that is only a lower bound is the defect this closes.
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

func (s *ErasureService) finishErasure(ctx context.Context, userID int64, job *db.ErasureJob) error {
	slog.Info("account erased", "user_id", userID, "erasure_job", job.ID, "files", len(job.Files))
	// The rest outlives the request: a canceled context must not leave the replay pipeline
	// naming the subject or a half-removed job.
	bg := context.WithoutCancel(ctx)
	if s.hub != nil {
		// Drop the user from every client and close their socket. Purging every frame naming
		// them is the job's next step, retried from the journal.
		s.hub.BroadcastMemberBan(userID)
	}
	if err := s.runJob(bg, job); err != nil {
		return fmt.Errorf("%w: job %d: %w", ErrErasureFilesPending, job.ID, err)
	}
	return nil
}

func (s *ErasureService) runJob(ctx context.Context, job *db.ErasureJob) error {
	if job.State == db.ErasureStateQueued {
		return fmt.Errorf("erasure: job %d is still queued", job.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if !job.ReplayPurged {
		if err := s.purgeReplay(ctx, job.UserID, job.ID); err != nil {
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

// purgeReplay takes the erased user's frames out of the replay pipeline: through the hub
// when installed (ring buffer, persister barrier, events rows, producer tombstone), else
// the persisted rows alone (start-up replay, tests), since nothing is buffered yet.
func (s *ErasureService) purgeReplay(ctx context.Context, userID, jobID int64) error {
	if s.hub != nil {
		if err := s.hub.PurgeUserFromReplay(ctx, userID); err != nil {
			return err
		}
		return s.hub.PurgeErasedMessagesFromReplay(ctx, jobID)
	}
	if _, err := s.st.DeleteEventsForUser(ctx, userID); err != nil {
		return err
	}
	_, err := s.st.DeleteOrphanMessageEvents(ctx, jobID)
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

// Reconcile removes upload files no database row names (stranded by the orphan sweep or a
// restore). Only files older than cutoff qualify, so an upload whose row is not written
// yet is left alone; at most limit go per call. Returns how many were removed.
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
		if err := ctx.Err(); err != nil {
			return removed, fmt.Errorf("reconcile: %w", err)
		}
		// The batch lookup can be seconds old: a row that named this file since then keeps it.
		named, err := s.st.ReferencedStoredFiles(ctx, []string{name})
		if err != nil {
			return removed, fmt.Errorf("reconcile: re-check: %w", err)
		}
		if named[name] {
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
