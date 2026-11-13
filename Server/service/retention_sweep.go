package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// TickReport is what one retention tick did.
type TickReport struct {
	Channels     int
	Messages     int
	FilesRemoved int
	// Budgeted is true when the tick stopped at RetentionTickBudget with more to remove.
	Budgeted bool
}

// Tick runs one bounded sweep over every channel with an effective window, resuming unfinished runs' files
// first. Restart-safe: rows go per batch in their own transaction and a run's files are journaled before
// removal.
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
		skip, err := s.skipChannel(ctx, w.ChannelID, cutoff)
		if err != nil {
			sweepErr = err
			break
		}
		if skip {
			continue
		}
		// The marker is the durable intent that survives a restore. Write it before deleting: a crash after makes
		// the next start finish the sweep, while a marker failure leaves the rows untouched instead of losing the
		// anti-resurrection guarantee.
		sweep, err := s.recordMessagesMarker(ctx, w.ChannelID, cutoff)
		if err != nil {
			sweepErr = err
			break
		}
		_, exhausted, err := s.sweepChannel(ctx, run, w.ChannelID, cutoff)
		if err != nil {
			sweepErr = err
			break
		}
		if !exhausted {
			rep.Budgeted = true
		} else {
			s.noteSwept(ctx, w.ChannelID, sweep)
		}
	}
	rep.Channels = run.channels
	rep.Messages = run.messages
	if len(run.pending) > 0 && sweepErr == nil {
		sweepErr = fmt.Errorf("replay purge pending for %d messages, retried next tick", len(run.pending))
	}
	// The file and replay journals are current: every batch records them in the same transaction as its
	// deletions.
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

// skipChannel reports whether the tick leaves the channel alone: nothing is due and the marker needs no
// repair. Then there is no marker rewrite, writer transaction or swept record; when the marker and the swept
// record disagree, the channel takes the full path so a restart does not replay a stale cutoff.
func (s *RetentionService) skipChannel(ctx context.Context, channelID int64, cutoff time.Time) (bool, error) {
	due, err := s.st.HasRetentionCandidates(ctx, channelID, cutoff)
	if err != nil {
		return false, fmt.Errorf("retention probe for channel %d: %w", channelID, err)
	}
	if due {
		return false, nil
	}
	return s.sweepSettled(ctx, channelID)
}

// sweepSettled reports whether the channel's marker needs no repair: there is no marker store or marker, or
// the database recorded finishing the marker's sweep.
func (s *RetentionService) sweepSettled(ctx context.Context, channelID int64) (bool, error) {
	if s.markers == nil {
		return true, nil
	}
	sweep, err := s.markers.MessagesSweepID(ctx, channelID)
	if err != nil {
		return false, fmt.Errorf("retention marker sweep for channel %d: %w", channelID, err)
	}
	if sweep == "" {
		return true, nil
	}
	done, ok, err := s.st.RetentionSwept(ctx, channelID)
	if err != nil {
		return false, fmt.Errorf("retention swept record for channel %d: %w", channelID, err)
	}
	return ok && done == sweep, nil
}

// noteSwept records that the channel finished the marker's sweep named sweep; without a marker store
// there is nothing to compare with and nothing is recorded. A failed record only means the start-up replay
// runs again for the channel, so it is logged and the caller goes on.
func (s *RetentionService) noteSwept(ctx context.Context, channelID int64, sweep string) {
	if s.markers == nil {
		return
	}
	if err := s.st.RecordRetentionSwept(ctx, channelID, sweep); err != nil {
		slog.Warn("retention: recording the finished sweep failed, the start-up replay will run again", "channel_id", channelID, "err", err)
	}
}

// replayPlan is what one start-up replay decided for a channel: whether to sweep it and the marker's
// sweep id to record when that finishes.
type replayPlan struct {
	sweep string
	due   bool
}

// replayPlanFor decides once per channel whether the start-up replay sweeps it, and keeps the answer in
// plans so every marker naming the channel (a file can hold one from before a key change) follows the
// state the database was in when the replay began. A channel is not swept when the database itself
// finished the marker's last sweep: nothing a restore brought back is in it, and replaying anyway would
// take a message that was pinned at the sweep and unpinned since, which the current policy keeps. A
// database behind the marker (a restored older backup, or a sweep cut short) or with no record is swept.
func (s *RetentionService) replayPlanFor(ctx context.Context, plans map[int64]replayPlan, channelID int64) (replayPlan, error) {
	if plan, ok := plans[channelID]; ok {
		return plan, nil
	}
	sweep, err := s.markers.MessagesSweepID(ctx, channelID)
	if err != nil {
		return replayPlan{}, fmt.Errorf("retention marker sweep for channel %d: %w", channelID, err)
	}
	done, ok, err := s.st.RetentionSwept(ctx, channelID)
	if err != nil {
		return replayPlan{}, fmt.Errorf("retention swept record for channel %d: %w", channelID, err)
	}
	plan := replayPlan{sweep: sweep, due: !ok || done != sweep}
	plans[channelID] = plan
	return plan, nil
}

// sweepRun is the state one retention run accumulates across batches: budget left, the run row (runID is 0
// until something needs journaling), totals, journaled file names, and replay purges left pending for the
// next tick.
type sweepRun struct {
	runID    int64
	budget   int
	channels int
	messages int
	files    []string
	pending  []int64
}

// sweepChannel removes messages older than cutoff in batches until the channel is clean or the budget is
// spent, taking each batch's frames out of the replay tiers. A failed purge leaves its ids in run.pending;
// the rows are gone either way. SweepRetentionJournaled appends run.files and the replay ids inside each
// batch's deletion transaction, so a kill after commit leaves both resume handles durable; the run opens
// lazily there.
func (s *RetentionService) sweepChannel(ctx context.Context, run *sweepRun, channelID int64, cutoff time.Time) (removed int, exhausted bool, err error) {
	counted := false
	for run.budget > 0 {
		limit := min(RetentionBatch, run.budget)
		runID, ids, batchFiles, err := s.st.SweepRetentionJournaled(ctx, run.runID, channelID, cutoff, limit, !counted)
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

// purgeJournaled purges the replay tiers for ids already journaled by the deletion transaction; a failure
// stays journaled for the next tick.
func (s *RetentionService) purgeJournaled(ctx context.Context, runID int64, ids []int64, pending *[]int64) error {
	if err := s.purgeReplay(ctx, ids); err != nil {
		slog.Warn("retention: replay purge failed, journaled for the next tick", "run", runID, "messages", len(ids), "err", err)
		*pending = append(*pending, ids...)
		return nil
	}
	return s.st.RecordRetentionRunPurge(ctx, runID, *pending)
}

// purgeReplay takes swept messages' frames out of the replay pipeline: through the hub when
// installed, else the persisted rows alone (nothing is buffered at start-up).
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

// recordMessagesMarker writes the channel's retention intent with the channels sequence as floor and returns
// the id the marker gave this sweep ("" without a marker store). It runs before deletion and is required:
// without it a restored backup could resurrect swept data.
func (s *RetentionService) recordMessagesMarker(ctx context.Context, channelID int64, cutoff time.Time) (string, error) {
	if s.markers == nil {
		return "", nil
	}
	seq, err := s.st.SequenceValue(ctx, db.SequenceFloorChannels)
	if err != nil {
		return "", fmt.Errorf("retention marker sequence for channel %d: %w", channelID, err)
	}
	if err := s.markers.RecordMessagesSweep(ctx, channelID, cutoff.Format(dbtime.SQLiteLayout), seq); err != nil {
		return "", fmt.Errorf("retention marker for channel %d: %w", channelID, err)
	}
	sweep, err := s.markers.MessagesSweepID(ctx, channelID)
	if err != nil {
		return "", fmt.Errorf("retention marker for channel %d: %w", channelID, err)
	}
	return sweep, nil
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

// resumeRuns finishes what earlier runs left: a journaled replay purge, then the file half.
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

// ReplayMarkers re-applies the messages-scoped deletion markers at start-up: a restored backup holding
// messages older than a channel's recorded cutoff loses them again, files included. Returns the number
// removed.
func (s *RetentionService) ReplayMarkers(ctx context.Context) (int, error) {
	if s.markers == nil {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A previous process may have died after a journaled deletion but before its purge or file removal; finish
	// that before the server serves.
	if err := s.resumeRuns(ctx); err != nil {
		return 0, fmt.Errorf("resume retention runs before marker replay: %w", err)
	}
	plans := map[int64]replayPlan{}
	return s.markers.ReplayMessages(ctx, func(ctx context.Context, channelID int64, cutoff string) (int, error) {
		t, err := time.Parse(dbtime.SQLiteLayout, cutoff)
		if err != nil {
			return 0, fmt.Errorf("marker cutoff %q: %w", cutoff, err)
		}
		if ch, err := s.st.GetChannel(ctx, channelID); err != nil || ch == nil {
			return 0, nil //nolint:nilerr // a marker for a channel that no longer exists has nothing to sweep
		}
		plan, err := s.replayPlanFor(ctx, plans, channelID)
		if err != nil || !plan.due {
			return 0, err
		}
		total := 0
		for {
			// One pass is one fresh RetentionTickBudget with its own run, finished before the next, so only one
			// pass's ids and file names are in memory however large the backlog.
			run := &sweepRun{budget: RetentionTickBudget}
			removed, exhausted, sweepErr := s.sweepChannel(ctx, run, channelID, t)
			total += removed
			if len(run.pending) > 0 && sweepErr == nil {
				sweepErr = fmt.Errorf("replay purge pending for %d messages, retried next tick", len(run.pending))
			}
			if run.runID != 0 {
				// A pass that swept nothing opened no run, so a no-op boot adds no empty retention_runs row.
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
				s.noteSwept(ctx, channelID, plan.sweep)
				return total, nil
			}
		}
	})
}
