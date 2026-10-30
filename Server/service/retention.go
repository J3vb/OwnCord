package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// RetentionStore is the slice of Store the retention sweep needs.
type RetentionStore interface {
	db.Auditor
	RetentionPolicySnapshot(ctx context.Context) (*db.RetentionPolicySnapshot, error)
	PreviewRetentionChange(ctx context.Context, change db.RetentionChange, revision string, observed time.Time) (*db.RetentionChangeEffect, error)
	ApplyRetentionChange(ctx context.Context, actorID int64, change db.RetentionChange, revision string) (string, error)
	ServerRetentionDays(ctx context.Context) (int, error)
	ListChannelRetention(ctx context.Context) ([]db.ChannelRetention, error)
	GetChannelRetention(ctx context.Context, channelID int64) (*db.ChannelRetention, error)
	SetChannelRetention(ctx context.Context, channelID int64, days int, updatedBy int64) error
	DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error)
	RetentionWindows(ctx context.Context) ([]db.RetentionWindow, error)
	CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time, includeImported bool) (int64, error)
	SweepRetentionJournaled(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int, countChannel, includeImported bool) (int64, []int64, []string, error)
	DeleteEventsForMessages(ctx context.Context, ids []int64) (int64, error)
	SequenceValue(ctx context.Context, table string) (int64, error)
	StartRetentionRun(ctx context.Context) (int64, error)
	RecordRetentionRunFiles(ctx context.Context, runID int64, channels, deleted int, files []string) error
	RecordRetentionRunPurge(ctx context.Context, runID int64, ids []int64) error
	FinishRetentionRun(ctx context.Context, runID int64, filesRemoved int, lastError string) error
	ListUnfinishedRetentionRuns(ctx context.Context) ([]db.RetentionRun, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	ListChannels(ctx context.Context) ([]db.Channel, error)
}

// RetentionMinDays is the smallest window the policy accepts. RetentionMaxDays
// mirrors db.RetentionMaxDays, one source: the db read paths fail closed on the
// same ceiling this write-side check enforces, and a copy could drift.
const RetentionMinDays = 1

const RetentionMaxDays = db.RetentionMaxDays

// RetentionTickBudget is the most messages one maintenance tick removes across
// channels, in batches of RetentionBatch; the rest waits so a backlog never holds
// the writer long.
const (
	RetentionTickBudget = 5000
	RetentionBatch      = 500
)

// ErrRetentionDMChannel is returned for a policy on a DM channel: DMs are never in scope.
var ErrRetentionDMChannel = errors.New("retention does not apply to direct messages")

// RetentionHub is the sweep's slice of the hub: the replay purge for removed
// messages. *ws.Hub satisfies it.
type RetentionHub interface {
	PurgeMessagesFromReplay(ctx context.Context, ids []int64) error
}

// RetentionService is the message-retention policy and sweep: indefinite by
// default, a server-wide window in settings, a per-channel override either way,
// pinned messages exempt, DMs never in scope, no hold. A sweep hard-deletes
// past-window messages with the erasure's mechanics (mention reversal, FTS via
// trigger, attachment rows), journals the files in retention_runs and removes them
// after commit, and records a messages-scoped deletion marker per channel so a
// restored backup is swept again to the same cutoff.
type RetentionService struct {
	previewKey [32]byte
	mu         syncutil.Mutex
	st         RetentionStore
	files      FileRemover
	hub        RetentionHub
	markers    *db.MarkerStore
	now        func() time.Time
}

// NewRetentionService wires the sweep over st.
func NewRetentionService(st RetentionStore) *RetentionService {
	s := &RetentionService{st: st, now: time.Now}
	_, _ = rand.Read(s.previewKey[:])
	return s
}

// SetFiles installs the upload storage the sweep removes files through.
func (s *RetentionService) SetFiles(f FileRemover) { s.files = f }

// SetMarkers installs the deletion-marker store the sweep records into.
func (s *RetentionService) SetMarkers(m *db.MarkerStore) { s.markers = m }

// SetHub installs the hub: a sweep then purges the whole replay pipeline (ring
// buffer, persister barrier, events rows, producer tombstone), not only persisted
// rows. Call it at the composition root before serving.
func (s *RetentionService) SetHub(h RetentionHub) { s.hub = h }

// SetClock replaces the clock (tests).
func (s *RetentionService) SetClock(now func() time.Time) { s.now = now }

// RetentionPolicy is what the admin panel reads: the server window and every
// channel override.
type RetentionPolicy = db.RetentionPolicySnapshot

// ServerDays returns only the server-default window (0 keeps indefinitely);
// channel overrides stay on the admin-only Policy path.
func (s *RetentionService) ServerDays(ctx context.Context) (int, error) {
	return s.st.ServerRetentionDays(ctx)
}

// Policy returns the current policy.
func (s *RetentionService) Policy(ctx context.Context) (*RetentionPolicy, error) {
	p, err := s.st.RetentionPolicySnapshot(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return p, nil
}

// ChannelPolicy preserves the channel-write response, audit metadata included.
func (s *RetentionService) ChannelPolicy(ctx context.Context, channelID int64) (*db.ChannelRetention, error) {
	p, err := s.st.GetChannelRetention(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return p, nil
}

// SetChannelPolicy sets a channel's window (days >= RetentionMinDays, or 0 to
// keep the channel forever under a server window) and audits old -> new. Refused
// for DM and unknown channels.
func (s *RetentionService) SetChannelPolicy(ctx context.Context, actorID, channelID int64, days int) (*db.ChannelRetention, error) {
	if days != 0 && (days < RetentionMinDays || days > RetentionMaxDays) {
		return nil, fmt.Errorf("%w: days must be 0 (keep forever) or between %d and %d", ErrBadRequest, RetentionMinDays, RetentionMaxDays)
	}
	if err := s.retentionChannel(ctx, channelID); err != nil {
		return nil, err
	}
	previous, err := s.st.GetChannelRetention(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if err := s.st.SetChannelRetention(ctx, channelID, days, actorID); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "channel_retention_change", "channel", channelID,
		fmt.Sprintf("retention %s -> %d days", describeChannelWindow(previous), days))
	return s.st.GetChannelRetention(ctx, channelID)
}

// ClearChannelPolicy removes a channel's override so the server window applies
// (audited); not-found when it has none.
func (s *RetentionService) ClearChannelPolicy(ctx context.Context, actorID, channelID int64) error {
	if err := s.retentionChannel(ctx, channelID); err != nil {
		return err
	}
	previous, err := s.st.GetChannelRetention(ctx, channelID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	removed, err := s.st.DeleteChannelRetention(ctx, channelID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !removed {
		return fmt.Errorf("%w: channel has no retention override", ErrNotFound)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "channel_retention_change", "channel", channelID,
		fmt.Sprintf("retention %s -> server policy", describeChannelWindow(previous)))
	return nil
}

func describeChannelWindow(c *db.ChannelRetention) string {
	if c == nil {
		return "server policy"
	}
	return fmt.Sprintf("%d days", c.Days)
}

// RetentionPreview is one channel's line of the effect preview.
type RetentionPreview struct {
	db.RetentionWindow
	Cutoff      string `json:"cutoff"`
	WouldDelete int64  `json:"would_delete"`
}

// Preview reports, per channel with an effective window, how many messages the
// next sweep would remove.
func (s *RetentionService) Preview(ctx context.Context) ([]RetentionPreview, error) {
	windows, err := s.st.RetentionWindows(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]RetentionPreview, 0, len(windows))
	for _, w := range windows {
		cutoff := s.cutoff(w.Days)
		n, err := s.st.CountRetentionCandidates(ctx, w.ChannelID, cutoff, w.Source == "channel")
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInternal, err)
		}
		out = append(out, RetentionPreview{RetentionWindow: w, Cutoff: cutoff.Format(time.RFC3339), WouldDelete: n})
	}
	return out, nil
}

// cutoff is now minus the window in UTC: message timestamps are UTC strings, so
// DST or a local-zone host never moves the boundary.
func (s *RetentionService) cutoff(days int) time.Time {
	return s.now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
}

// TickReport is what one retention tick did.
type TickReport struct {
	Channels     int
	Messages     int
	FilesRemoved int
	// Budgeted is true when the tick stopped at RetentionTickBudget with more to
	// remove.
	Budgeted bool
}

// Tick runs one bounded sweep over every channel with an effective window,
// resuming unfinished runs' files first. Restart-safe: rows go per batch in their
// own transaction and a run's files are journaled before removal.
func (s *RetentionService) Tick(ctx context.Context) (TickReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rep TickReport
	if err := s.resumeRuns(ctx); err != nil {
		slog.Warn("retention: resuming unfinished runs", "err", err)
	}
	windows, err := s.st.RetentionWindows(ctx)
	if err != nil {
		return rep, err
	}
	if len(windows) == 0 {
		return rep, nil
	}
	run := &sweepRun{budget: RetentionTickBudget}
	var sweepErr error
	for _, w := range windows {
		if run.budget <= 0 {
			rep.Budgeted = true
			break
		}
		cutoff := s.cutoff(w.Days)
		// The marker is the durable intent that survives a restore. Write it before
		// deleting: a crash after makes the next start finish the sweep, while a marker
		// failure leaves the rows untouched instead of losing the anti-resurrection
		// guarantee.
		if s.markers != nil {
			if err := s.recordMessagesMarker(ctx, w.ChannelID, cutoff, w.Source == "channel"); err != nil {
				sweepErr = err
				break
			}
		}
		_, exhausted, err := s.sweepChannel(ctx, run, w.ChannelID, cutoff, w.Source == "channel")
		if err != nil {
			sweepErr = err
			break
		}
		if !exhausted {
			rep.Budgeted = true
		}
	}
	rep.Channels = run.channels
	rep.Messages = run.messages
	if len(run.pending) > 0 && sweepErr == nil {
		sweepErr = fmt.Errorf("replay purge pending for %d messages, retried next tick", len(run.pending))
	}
	// The file and replay journals are current: every batch records them in the same
	// transaction as its deletions.
	removedFiles, fileErr := s.removeFiles(run.files)
	rep.FilesRemoved = removedFiles
	errText := ""
	if sweepErr != nil {
		errText = sweepErr.Error()
	} else if fileErr != nil {
		errText = fileErr.Error()
	}
	if run.runID != 0 {
		if err := s.st.FinishRetentionRun(ctx, run.runID, removedFiles, errText); err != nil {
			return rep, err
		}
	}
	if rep.Messages > 0 {
		slog.Info("retention: swept", "run", run.runID, "channels", rep.Channels, "messages", rep.Messages, "files_removed", removedFiles, "budgeted", rep.Budgeted)
	}
	if sweepErr != nil {
		return rep, sweepErr
	}
	return rep, fileErr
}

// sweepRun is the state one retention run accumulates across batches (Tick or a
// marker-replay pass): the budget left, the run row (runID is 0 until something
// needs journaling, so a pass that removes nothing opens none), totals, journaled
// file names, and replay purges a failed purge left pending for the next tick.
type sweepRun struct {
	runID    int64
	budget   int
	channels int
	messages int
	files    []string
	pending  []int64
}

// sweepChannel removes messages older than cutoff in batches until the channel is
// clean (exhausted) or the budget is spent, taking each batch's frames out of the
// replay tiers behind the run's purge journal. A failed purge leaves its ids in
// run.pending for the next tick; the rows are gone either way.
// SweepRetentionJournaled appends run.files and the replay ids inside each batch's
// deletion transaction, so a kill after commit leaves both resume handles durable.
// The run opens lazily there when run.runID is zero.
func (s *RetentionService) sweepChannel(ctx context.Context, run *sweepRun, channelID int64, cutoff time.Time, includeImported bool) (removed int, exhausted bool, err error) {
	counted := false
	for run.budget > 0 {
		limit := min(RetentionBatch, run.budget)
		runID, ids, batchFiles, err := s.st.SweepRetentionJournaled(ctx, run.runID, channelID, cutoff, limit, !counted, includeImported)
		if err != nil {
			return removed, false, err
		}
		run.runID = runID
		removed += len(ids)
		run.budget -= len(ids)
		if len(ids) > 0 {
			run.messages += len(ids)
			run.files = append(run.files, batchFiles...)
			if !counted {
				run.channels++
				counted = true
			}
			if err := s.purgeJournaled(ctx, run.runID, ids, &run.pending); err != nil {
				return removed, false, err
			}
		}
		if len(ids) < limit {
			return removed, true, nil
		}
	}
	return removed, false, nil
}

// purgeJournaled purges the replay tiers for ids already journaled by the deletion
// transaction. Success clears this batch while preserving earlier failed batches;
// a failure stays journaled for the next tick.
func (s *RetentionService) purgeJournaled(ctx context.Context, runID int64, ids []int64, pending *[]int64) error {
	if err := s.purgeReplay(ctx, ids); err != nil {
		slog.Warn("retention: replay purge failed, journaled for the next tick", "run", runID, "messages", len(ids), "err", err)
		*pending = append(*pending, ids...)
		return nil
	}
	return s.st.RecordRetentionRunPurge(ctx, runID, *pending)
}

// purgeReplay takes swept messages' frames out of the replay pipeline: through the
// hub when installed, else (start-up replay, tests) the persisted rows alone,
// since nothing is buffered yet.
func (s *RetentionService) purgeReplay(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if s.hub != nil {
		return s.hub.PurgeMessagesFromReplay(ctx, ids)
	}
	_, err := s.st.DeleteEventsForMessages(ctx, ids)
	return err
}

// recordMessagesMarker writes the channel's retention intent with the channels
// sequence as floor. It runs before deletion and is required: without it a
// restored backup could resurrect swept data.
func (s *RetentionService) recordMessagesMarker(ctx context.Context, channelID int64, cutoff time.Time, includeImported bool) error {
	seq, err := s.st.SequenceValue(ctx, db.SequenceFloorChannels)
	if err != nil {
		return fmt.Errorf("retention marker sequence for channel %d: %w", channelID, err)
	}
	if err := s.markers.RecordMessagesSweep(ctx, channelID, cutoff.Format(dbtime.SQLiteLayout), seq, includeImported); err != nil {
		return fmt.Errorf("retention marker for channel %d: %w", channelID, err)
	}
	return nil
}

// RetentionChannel is a channel a policy can be set on: id and name only, so the
// page needs nothing beyond MANAGE_SERVER to list them.
type RetentionChannel struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// Channels lists the non-DM channels.
func (s *RetentionService) Channels(ctx context.Context) ([]RetentionChannel, error) {
	all, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]RetentionChannel, 0, len(all))
	for i := range all {
		if all[i].Type != "dm" {
			out = append(out, RetentionChannel{ID: all[i].ID, Name: all[i].Name})
		}
	}
	return out, nil
}

func (s *RetentionService) removeFiles(files []string) (int, error) {
	if len(files) == 0 {
		return 0, nil
	}
	if s.files == nil {
		return 0, errors.New("no file storage configured")
	}
	removed := 0
	var lastErr error
	for _, name := range files {
		if err := s.files.Delete(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
			lastErr = fmt.Errorf("remove %s: %w", name, err)
			continue
		}
		removed++
	}
	return removed, lastErr
}

// resumeRuns finishes what earlier runs left: a journaled replay purge, then the
// file half.
func (s *RetentionService) resumeRuns(ctx context.Context) error {
	runs, err := s.st.ListUnfinishedRetentionRuns(ctx)
	if err != nil {
		return err
	}
	var firstErr error
	for _, r := range runs {
		if len(r.PurgePending) > 0 {
			if err := s.purgeReplay(ctx, r.PurgePending); err != nil {
				slog.Warn("retention: journaled replay purge failed again", "run", r.ID, "messages", len(r.PurgePending), "err", err)
				if firstErr == nil {
					firstErr = err
				}
			} else if err := s.st.RecordRetentionRunPurge(ctx, r.ID, nil); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		if r.FinishedAt != nil && r.FilesRemoved >= len(r.Files) {
			// Only the purge was outstanding.
			continue
		}
		removed, fileErr := s.removeFiles(r.Files)
		errText := ""
		if fileErr != nil {
			errText = fileErr.Error()
			if firstErr == nil {
				firstErr = fileErr
			}
		}
		if err := s.st.FinishRetentionRun(ctx, r.ID, removed, errText); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// ReplayMarkers re-applies the messages-scoped deletion markers at start-up: a
// restored backup holding messages older than a channel's recorded cutoff loses
// them again, files included. Returns the number of messages removed.
func (s *RetentionService) ReplayMarkers(ctx context.Context) (int, error) {
	if s.markers == nil {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A previous process may have died after a journaled deletion but before its
	// purge or file removal; finish that before the replay completes and the server
	// serves.
	if err := s.resumeRuns(ctx); err != nil {
		return 0, fmt.Errorf("resume retention runs before marker replay: %w", err)
	}
	return s.markers.ReplayMessages(ctx, func(ctx context.Context, channelID int64, cutoff string, includeImported bool) (int, error) {
		t, err := time.Parse(dbtime.SQLiteLayout, cutoff)
		if err != nil {
			return 0, fmt.Errorf("marker cutoff %q: %w", cutoff, err)
		}
		if ch, err := s.st.GetChannel(ctx, channelID); err != nil || ch == nil {
			return 0, nil //nolint:nilerr // a marker for a channel that no longer exists has nothing to sweep
		}
		total := 0
		for {
			// One pass is one fresh RetentionTickBudget with its own run, journaled and
			// finished before the next. However large the backlog, it is all removed by the
			// time the loop returns, and only one pass's ids and file names are in memory.
			run := &sweepRun{budget: RetentionTickBudget}
			removed, exhausted, sweepErr := s.sweepChannel(ctx, run, channelID, t, includeImported)
			total += removed
			if len(run.pending) > 0 && sweepErr == nil {
				sweepErr = fmt.Errorf("replay purge pending for %d messages, retried next tick", len(run.pending))
			}
			if run.runID != 0 {
				// Something was swept: close its run. A pass that swept nothing opened none, so a
				// no-op boot adds no empty retention_runs row.
				removedFiles, fileErr := s.removeFiles(run.files)
				errText := ""
				if sweepErr != nil {
					errText = sweepErr.Error()
				} else if fileErr != nil {
					errText = fileErr.Error()
				}
				if err := s.st.FinishRetentionRun(ctx, run.runID, removedFiles, errText); err != nil && sweepErr == nil {
					sweepErr = err
				}
			}
			if sweepErr != nil {
				return total, sweepErr
			}
			if exhausted {
				return total, nil
			}
		}
	})
}
