package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// RetentionStore is the slice of Store the retention sweep needs.
type RetentionStore interface {
	db.Auditor
	ServerRetentionDays(ctx context.Context) (int, error)
	ListChannelRetention(ctx context.Context) ([]db.ChannelRetention, error)
	GetChannelRetention(ctx context.Context, channelID int64) (*db.ChannelRetention, error)
	SetChannelRetention(ctx context.Context, channelID int64, days int, updatedBy int64) error
	DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error)
	RetentionWindows(ctx context.Context) ([]db.RetentionWindow, error)
	CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (int64, error)
	SweepRetentionJournaled(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int) ([]int64, []string, error)
	DeleteEventsForMessages(ctx context.Context, ids []int64) (int64, error)
	SequenceValue(ctx context.Context, table string) (int64, error)
	StartRetentionRun(ctx context.Context) (int64, error)
	RecordRetentionRunFiles(ctx context.Context, runID int64, channels, deleted int, files []string) error
	RecordRetentionRunPurge(ctx context.Context, runID int64, ids []int64) error
	FinishRetentionRun(ctx context.Context, runID int64, filesRemoved int, lastError string) error
	ListUnfinishedRetentionRuns(ctx context.Context) ([]db.RetentionRun, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// Retention bounds: the smallest window the policy accepts (owner decision
// 4) and the largest, which keeps the day arithmetic away from overflow.
const (
	RetentionMinDays = 1
	RetentionMaxDays = 3650
)

// RetentionTickBudget is how many messages one maintenance tick removes at
// most, across channels, in batches of RetentionBatch; the rest waits for
// the next tick so a large backlog never holds the writer for long.
const (
	RetentionTickBudget = 5000
	RetentionBatch      = 500
)

// ErrRetentionDMChannel is returned for a policy on a DM channel: DMs are
// never in scope (owner decision 4).
var ErrRetentionDMChannel = errors.New("retention does not apply to direct messages")

// RetentionHub is what the sweep needs from the WebSocket hub: the replay
// purge for the messages a sweep removed. *ws.Hub satisfies it.
type RetentionHub interface {
	PurgeMessagesFromReplay(ctx context.Context, ids []int64) error
}

// RetentionService is the message-retention policy and its sweep (B4-11,
// BPR-054): indefinite by default, a server-wide window in settings, a
// per-channel override in either direction, pinned messages exempt, DMs
// never in scope, no hold mechanism (owner decision 5). Each sweep
// hard-deletes past-window messages with the erasure's mechanics (mention
// reversal, FTS via trigger, attachment rows), journals the files in
// retention_runs and removes them after commit, and records a
// messages-scoped deletion marker per channel so a restored backup is
// swept again to the same cutoff (HP-4 decision 6).
type RetentionService struct {
	mu      syncutil.Mutex
	st      RetentionStore
	files   FileRemover
	hub     RetentionHub
	markers *db.MarkerStore
	now     func() time.Time
}

// NewRetentionService wires the sweep over st.
func NewRetentionService(st RetentionStore) *RetentionService {
	return &RetentionService{st: st, now: time.Now}
}

// SetFiles installs the upload storage the sweep removes files through.
func (s *RetentionService) SetFiles(f FileRemover) { s.files = f }

// SetMarkers installs the deletion-marker store the sweep records into.
func (s *RetentionService) SetMarkers(m *db.MarkerStore) { s.markers = m }

// SetHub installs the hub: from then on a sweep purges the replay pipeline
// through it — ring buffer, persister barrier, events rows, the producer
// tombstone — instead of the persisted rows alone. Call it at the
// composition root before serving.
func (s *RetentionService) SetHub(h RetentionHub) { s.hub = h }

// SetClock replaces the clock (tests).
func (s *RetentionService) SetClock(now func() time.Time) { s.now = now }

// RetentionPolicy is what the admin panel reads: the server window and
// every channel override.
type RetentionPolicy struct {
	ServerDays int                   `json:"server_days"`
	Channels   []db.ChannelRetention `json:"channels"`
}

// Policy returns the current policy.
func (s *RetentionService) Policy(ctx context.Context) (*RetentionPolicy, error) {
	days, err := s.st.ServerRetentionDays(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	channels, err := s.st.ListChannelRetention(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return &RetentionPolicy{ServerDays: days, Channels: channels}, nil
}

// SetChannelPolicy sets a channel's window (days >= RetentionMinDays, or 0
// to keep the channel forever under a server window) and audits the change
// old -> new. Refused for DM channels and unknown channels.
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

// ClearChannelPolicy removes a channel's override so the server window
// applies; audited. Not-found when the channel has no override.
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

func (s *RetentionService) retentionChannel(ctx context.Context, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		return fmt.Errorf("%w: %w", ErrBadRequest, ErrRetentionDMChannel)
	}
	return nil
}

// RetentionPreview is one channel's line of the effect preview.
type RetentionPreview struct {
	db.RetentionWindow
	Cutoff      string `json:"cutoff"`
	WouldDelete int64  `json:"would_delete"`
}

// Preview reports, per channel with an effective window, how many messages
// the next sweep would remove — the owner-facing "would delete N" (BG-12).
func (s *RetentionService) Preview(ctx context.Context) ([]RetentionPreview, error) {
	windows, err := s.st.RetentionWindows(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]RetentionPreview, 0, len(windows))
	for _, w := range windows {
		cutoff := s.cutoff(w.Days)
		n, err := s.st.CountRetentionCandidates(ctx, w.ChannelID, cutoff)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInternal, err)
		}
		out = append(out, RetentionPreview{RetentionWindow: w, Cutoff: cutoff.Format(time.RFC3339), WouldDelete: n})
	}
	return out, nil
}

// cutoff is now minus the window, in UTC: messages timestamps are UTC
// strings, so a DST change or a local-zone host never moves the boundary.
func (s *RetentionService) cutoff(days int) time.Time {
	return s.now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
}

// TickReport is what one retention tick did.
type TickReport struct {
	Channels     int
	Messages     int
	FilesRemoved int
	// Budgeted is true when the tick stopped at RetentionTickBudget with
	// more to remove; the next tick continues.
	Budgeted bool
}

// Tick runs one bounded sweep over every channel with an effective window,
// resuming unfinished runs' files first. Restart-safe: rows go per batch in
// their own transaction, the files of a run are journaled before removal.
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
	runID, err := s.st.StartRetentionRun(ctx)
	if err != nil {
		return rep, err
	}
	var files []string
	var purgePending []int64
	budget := RetentionTickBudget
	var sweepErr error
	for _, w := range windows {
		if budget <= 0 {
			rep.Budgeted = true
			break
		}
		cutoff := s.cutoff(w.Days)
		// The marker is the durable retention intent that survives a restore.
		// Write it before deleting anything: a crash after this point makes the
		// next start finish the sweep, while a marker failure leaves the rows
		// untouched instead of silently losing the anti-resurrection guarantee.
		if s.markers != nil {
			if err := s.recordMessagesMarker(ctx, w.ChannelID, cutoff); err != nil {
				sweepErr = err
				break
			}
		}
		removed, swept, exhausted, err := s.sweepChannel(ctx, runID, w.ChannelID, cutoff, &budget, &purgePending)
		files = append(files, swept...)
		if err != nil {
			sweepErr = err
			break
		}
		if removed > 0 {
			rep.Channels++
			rep.Messages += removed
		}
		if !exhausted {
			rep.Budgeted = true
		}
	}
	if len(purgePending) > 0 && sweepErr == nil {
		sweepErr = fmt.Errorf("replay purge pending for %d messages, retried next tick", len(purgePending))
	}
	if err := s.st.RecordRetentionRunFiles(ctx, runID, rep.Channels, rep.Messages, files); err != nil {
		return rep, err
	}
	removedFiles, fileErr := s.removeFiles(files)
	rep.FilesRemoved = removedFiles
	errText := ""
	if sweepErr != nil {
		errText = sweepErr.Error()
	} else if fileErr != nil {
		errText = fileErr.Error()
	}
	if err := s.st.FinishRetentionRun(ctx, runID, removedFiles, errText); err != nil {
		return rep, err
	}
	if rep.Messages > 0 {
		slog.Info("retention: swept", "run", runID, "channels", rep.Channels, "messages", rep.Messages, "files_removed", removedFiles, "budgeted", rep.Budgeted)
	}
	if sweepErr != nil {
		return rep, sweepErr
	}
	return rep, fileErr
}

// sweepChannel removes messages older than cutoff in batches until the
// channel is clean or the budget is spent, taking each batch's frames out
// of the replay tiers behind the run's purge journal. exhausted reports the
// former. A purge that fails leaves its ids journaled in pending for the
// next tick; the rows are gone either way.
func (s *RetentionService) sweepChannel(ctx context.Context, runID, channelID int64, cutoff time.Time, budget *int, pending *[]int64) (removed int, files []string, exhausted bool, err error) {
	for *budget > 0 {
		limit := min(RetentionBatch, *budget)
		ids, batchFiles, err := s.st.SweepRetentionJournaled(ctx, runID, channelID, cutoff, limit)
		if err != nil {
			return removed, files, false, err
		}
		removed += len(ids)
		*budget -= len(ids)
		files = append(files, batchFiles...)
		if len(ids) > 0 {
			if err := s.purgeJournaled(ctx, runID, ids, pending); err != nil {
				return removed, files, false, err
			}
		}
		if len(ids) < limit {
			return removed, files, true, nil
		}
	}
	return removed, files, false, nil
}

// purgeJournaled purges the replay tiers for ids already placed in the run's
// journal by SweepRetentionJournaled's deletion transaction. A successful
// purge clears this batch while preserving earlier failed batches; a failed
// purge stays journaled for the next tick.
func (s *RetentionService) purgeJournaled(ctx context.Context, runID int64, ids []int64, pending *[]int64) error {
	if err := s.purgeReplay(ctx, ids); err != nil {
		slog.Warn("retention: replay purge failed, journaled for the next tick", "run", runID, "messages", len(ids), "err", err)
		*pending = append(*pending, ids...)
		return nil
	}
	return s.st.RecordRetentionRunPurge(ctx, runID, *pending)
}

// purgeReplay takes the swept messages' frames out of the replay pipeline:
// through the hub when one is installed (ring buffer, persister barrier,
// events rows, the producer tombstone); without one — the start-up replay,
// a test — the persisted rows alone, since nothing is buffered yet.
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

// recordMessagesMarker writes the channel's retention intent with the
// channels sequence as its floor. It runs before deletion and is required:
// without it a restored backup could resurrect data the sweep removed.
func (s *RetentionService) recordMessagesMarker(ctx context.Context, channelID int64, cutoff time.Time) error {
	seq, err := s.st.SequenceValue(ctx, db.SequenceFloorChannels)
	if err != nil {
		return fmt.Errorf("retention marker sequence for channel %d: %w", channelID, err)
	}
	if err := s.markers.RecordMessagesSweep(ctx, channelID, cutoff.Format("2006-01-02 15:04:05"), seq); err != nil {
		return fmt.Errorf("retention marker for channel %d: %w", channelID, err)
	}
	return nil
}

// removeFiles unlinks the journaled files; a missing file counts as removed.
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

// resumeRuns finishes what earlier runs left behind: a replay purge still
// journaled, then the file half.
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

// ReplayMarkers re-applies the messages-scoped deletion markers at start-up
// (HP-4 decision 6): a restored backup holding messages older than a
// channel's recorded cutoff loses them again, files included. Returns the
// number of messages removed.
func (s *RetentionService) ReplayMarkers(ctx context.Context) (int, error) {
	if s.markers == nil {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A previous start may have died after a journaled deletion. Finish that
	// work before applying the marker again or allowing the server to serve.
	if err := s.resumeRuns(ctx); err != nil {
		return 0, fmt.Errorf("resume retention runs before marker replay: %w", err)
	}
	return s.markers.ReplayMessages(ctx, func(ctx context.Context, channelID int64, cutoff string) (int, error) {
		t, err := time.Parse("2006-01-02 15:04:05", cutoff)
		if err != nil {
			return 0, fmt.Errorf("marker cutoff %q: %w", cutoff, err)
		}
		if ch, err := s.st.GetChannel(ctx, channelID); err != nil || ch == nil {
			return 0, nil //nolint:nilerr // a marker for a channel that no longer exists has nothing to sweep
		}
		runID, err := s.st.StartRetentionRun(ctx)
		if err != nil {
			return 0, err
		}
		total := 0
		var files []string
		var pending []int64
		for {
			batchIDs, batchFiles, err := s.st.SweepRetentionJournaled(ctx, runID, channelID, t, RetentionBatch)
			if err != nil {
				return total, err
			}
			total += len(batchIDs)
			files = append(files, batchFiles...)
			if len(batchIDs) > 0 {
				if err := s.purgeJournaled(ctx, runID, batchIDs, &pending); err != nil {
					return total, err
				}
			}
			if len(batchIDs) < RetentionBatch {
				break
			}
		}
		if err := s.st.RecordRetentionRunFiles(ctx, runID, 1, total, files); err != nil {
			return total, err
		}
		removed, fileErr := s.removeFiles(files)
		var replayErr error
		if len(pending) > 0 {
			replayErr = fmt.Errorf("replay purge pending for %d messages", len(pending))
		}
		errText := ""
		if replayErr != nil {
			errText = replayErr.Error()
		} else if fileErr != nil {
			errText = fileErr.Error()
		}
		if err := s.st.FinishRetentionRun(ctx, runID, removed, errText); err != nil {
			return total, err
		}
		if replayErr != nil {
			return total, replayErr
		}
		return total, fileErr
	})
}
