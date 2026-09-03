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
	SweepRetention(ctx context.Context, channelID int64, cutoff time.Time, limit int) (int, []string, error)
	StartRetentionRun(ctx context.Context) (int64, error)
	RecordRetentionRunFiles(ctx context.Context, runID int64, channels, deleted int, files []string) error
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
	budget := RetentionTickBudget
	var sweepErr error
	for _, w := range windows {
		if budget <= 0 {
			rep.Budgeted = true
			break
		}
		cutoff := s.cutoff(w.Days)
		removed, swept, exhausted, err := s.sweepChannel(ctx, w.ChannelID, cutoff, &budget)
		files = append(files, swept...)
		if err != nil {
			sweepErr = err
			break
		}
		if removed > 0 {
			rep.Channels++
			rep.Messages += removed
			// The marker records the cutoff only once the channel is fully
			// swept to it; a budgeted channel records nothing and continues
			// next tick.
			if exhausted && s.markers != nil {
				if mErr := s.markers.RecordMessagesSweep(ctx, w.ChannelID, cutoff.Format("2006-01-02 15:04:05")); mErr != nil {
					slog.Error("retention: could not record the messages marker", "channel_id", w.ChannelID, "err", mErr)
				}
			}
		}
		if !exhausted {
			rep.Budgeted = true
		}
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
// channel is clean or the budget is spent. exhausted reports the former.
func (s *RetentionService) sweepChannel(ctx context.Context, channelID int64, cutoff time.Time, budget *int) (removed int, files []string, exhausted bool, err error) {
	for *budget > 0 {
		limit := min(RetentionBatch, *budget)
		n, batchFiles, err := s.st.SweepRetention(ctx, channelID, cutoff, limit)
		if err != nil {
			return removed, files, false, err
		}
		removed += n
		*budget -= n
		files = append(files, batchFiles...)
		if n < limit {
			return removed, files, true, nil
		}
	}
	return removed, files, false, nil
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

// resumeRuns finishes the file half of runs an earlier process left behind.
func (s *RetentionService) resumeRuns(ctx context.Context) error {
	runs, err := s.st.ListUnfinishedRetentionRuns(ctx)
	if err != nil {
		return err
	}
	var firstErr error
	for _, r := range runs {
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
	return s.markers.ReplayMessages(ctx, func(ctx context.Context, channelID int64, cutoff string) (int, error) {
		t, err := time.Parse("2006-01-02 15:04:05", cutoff)
		if err != nil {
			return 0, fmt.Errorf("marker cutoff %q: %w", cutoff, err)
		}
		if ch, err := s.st.GetChannel(ctx, channelID); err != nil || ch == nil {
			return 0, nil //nolint:nilerr // a marker for a channel that no longer exists has nothing to sweep
		}
		total := 0
		var files []string
		for {
			n, batchFiles, err := s.st.SweepRetention(ctx, channelID, t, RetentionBatch)
			if err != nil {
				return total, err
			}
			total += n
			files = append(files, batchFiles...)
			if n < RetentionBatch {
				break
			}
		}
		if total > 0 {
			runID, err := s.st.StartRetentionRun(ctx)
			if err != nil {
				return total, err
			}
			if err := s.st.RecordRetentionRunFiles(ctx, runID, 1, total, files); err != nil {
				return total, err
			}
			removed, fileErr := s.removeFiles(files)
			errText := ""
			if fileErr != nil {
				errText = fileErr.Error()
			}
			if err := s.st.FinishRetentionRun(ctx, runID, removed, errText); err != nil {
				return total, err
			}
		}
		return total, nil
	})
}
