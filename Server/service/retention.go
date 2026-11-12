package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
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
	CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (int64, error)
	HasRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (bool, error)
	SweepRetentionJournaled(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int, countChannel bool) (int64, []int64, []string, error)
	RetentionSwept(ctx context.Context, channelID int64) (sweep string, ok bool, err error)
	RecordRetentionSwept(ctx context.Context, channelID int64, sweep string) error
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

// RetentionMinDays is the smallest window the policy accepts. RetentionMaxDays mirrors
// db.RetentionMaxDays (one source: db read paths fail closed on the same ceiling).
const RetentionMinDays = 1

const RetentionMaxDays = db.RetentionMaxDays

// RetentionTickBudget is the most messages one maintenance tick removes across channels, in batches of
// RetentionBatch; the rest waits so a backlog never holds the writer long.
const (
	RetentionTickBudget = 5000
	RetentionBatch      = 500
)

// ErrRetentionDMChannel is returned for a policy on a DM channel: DMs are never in scope.
var ErrRetentionDMChannel = errors.New("retention does not apply to direct messages")

// RetentionHub is the sweep's slice of the hub: the replay purge for removed messages.
type RetentionHub interface {
	PurgeMessagesFromReplay(ctx context.Context, ids []int64) error
}

// RetentionService is the message-retention policy and sweep: indefinite by default, a server-wide window, a
// per-channel override either way, pinned messages exempt, DMs never in scope. A sweep hard-deletes
// past-window messages with the erasure's mechanics, journals the files in retention_runs and removes them
// after commit, and records a messages-scoped deletion marker per channel so a restored backup is swept again
// to the same cutoff.
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

// SetHub installs the hub: a sweep then purges the whole replay pipeline (ring buffer, persister barrier,
// events rows, producer tombstone), not only persisted rows. Call before serving.
func (s *RetentionService) SetHub(h RetentionHub) { s.hub = h }

// SetClock replaces the clock (tests).
func (s *RetentionService) SetClock(now func() time.Time) { s.now = now }

// RetentionPolicy is what the admin panel reads: the server window and every channel override.
type RetentionPolicy = db.RetentionPolicySnapshot

// ServerDays returns only the server-default window (0 keeps indefinitely); channel overrides stay on the
// admin-only Policy path.
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

// SetChannelPolicy sets a channel's window (days >= RetentionMinDays, or 0 to keep the channel forever under
// a server window) and audits old -> new. Refused for DM and unknown channels.
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

// ClearChannelPolicy removes a channel's override so the server window applies (audited); not-found when it
// has none.
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

// Preview reports, per channel with an effective window, how many messages the next sweep would remove.
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

// cutoff is now minus the window in UTC: message timestamps are UTC strings, so DST or a local-zone host
// never moves the boundary.
func (s *RetentionService) cutoff(days int) time.Time {
	return s.now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
}

// RetentionChannel is a channel a policy can be set on: id and name only.
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
		out = append(out, RetentionChannel{ID: all[i].ID, Name: all[i].Name})
	}
	return out, nil
}
