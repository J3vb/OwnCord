package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"
	"unicode/utf8"

	"github.com/owncord/server/db"
	"github.com/owncord/server/telemetry"
)

// DMService handles direct message channel operations.
type DMService struct {
	st Store
}

// NewDMService creates a DMService.
func NewDMService(st Store) *DMService {
	return &DMService{st: st}
}

// CreateDMResult holds the result of creating or fetching a DM channel.
type CreateDMResult struct {
	Channel   *db.Channel
	Created   bool
	Recipient *db.User
}

// CreateDM creates or retrieves a DM channel between two users.
// Validates that neither user has blocked the other.
func (s *DMService) CreateDM(ctx context.Context, userID, recipientID int64) (*CreateDMResult, error) {
	ctx, span := telemetry.GlobalTracer("service/dm").Start(ctx, "DMService.CreateDM",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("recipient_id", recipientID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "CreateDM"))
		span.End()
	}()

	if recipientID <= 0 {
		return nil, fmt.Errorf("%w: recipient_id must be positive", ErrBadRequest)
	}
	if userID == recipientID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", ErrBadRequest)
	}

	recipient, err := s.st.GetUserByID(ctx, recipientID)
	if err != nil || recipient == nil {
		return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
	}

	blocked, err := s.st.IsEitherBlocked(ctx, userID, recipientID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check block status: %v", ErrInternal, err)
	}
	if blocked {
		return nil, fmt.Errorf("%w: cannot create DM — user is blocked", ErrForbidden)
	}

	ch, created, err := s.st.GetOrCreateDMChannel(ctx, userID, recipientID)
	if err != nil {
		slog.Error("DMService.CreateDM", "err", err)
		return nil, fmt.Errorf("%w: failed to create DM channel", ErrInternal)
	}

	return &CreateDMResult{
		Channel:   ch,
		Created:   created,
		Recipient: recipient,
	}, nil
}

// ListDMs returns all open DM channels for a user.
func (s *DMService) ListDMs(ctx context.Context, userID int64) ([]db.DMChannelInfo, error) {
	dms, err := s.st.GetUserDMChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list DMs: %v", ErrInternal, err)
	}
	return dms, nil
}

// CloseDMResult describes what closing a DM actually did, so the caller knows
// which events to send.
type CloseDMResult struct {
	// Left is true when the caller left a *group* DM: they are no longer a
	// participant, and the remaining members need to be told.
	Left bool
	// ChannelDeleted is true when the caller was the last participant of a
	// group and the channel row went with them.
	ChannelDeleted bool
	// RemainingParticipantIDs is who is still in the group after a leave. Empty
	// for a 1:1 close, which changes nothing for the other party.
	RemainingParticipantIDs []int64
}

// CloseDM closes a DM channel for a user.
//
// For a 1:1 DM this hides the conversation from the caller's sidebar and
// nothing more — the other party keeps their copy, and the next message from
// either side re-opens it. For a group DM it is a *leave*: the caller comes
// out of dm_participants, stops receiving the group's messages, and cannot
// re-open it without being re-added. The two meanings share a route because
// they share a gesture ("get this out of my list"), but they are different
// operations and the result says which one ran.
func (s *DMService) CloseDM(ctx context.Context, userID, channelID int64) (*CloseDMResult, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}

	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM kind: %v", ErrInternal, err)
	}

	if !isGroup {
		if err := s.st.CloseDM(ctx, userID, channelID); err != nil {
			return nil, fmt.Errorf("%w: failed to close DM: %v", ErrInternal, err)
		}
		slog.Debug("DM closed", "user_id", userID, "channel_id", channelID)
		return &CloseDMResult{}, nil
	}

	// Read the survivors *before* the leave: after it, the caller is gone from
	// dm_participants and a post-hoc read could not tell "left" from "was
	// never in it" if the delete half-succeeded.
	remaining, err := s.st.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM participants: %v", ErrInternal, err)
	}
	survivors := make([]int64, 0, len(remaining))
	for _, pid := range remaining {
		if pid != userID {
			survivors = append(survivors, pid)
		}
	}

	deleted, err := s.st.LeaveGroupDM(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to leave group DM: %v", ErrInternal, err)
	}

	slog.Debug("group DM left", "user_id", userID, "channel_id", channelID, "deleted", deleted)
	return &CloseDMResult{
		Left:                    true,
		ChannelDeleted:          deleted,
		RemainingParticipantIDs: survivors,
	}, nil
}

// ─── Group DMs ──────────────────────────────────────────────────────────────

// MaxGroupDMNameLen bounds the optional group name. It matches the channel
// name cap: a group DM name renders in the same sidebar row a channel name
// does, so a longer one would only ever be shown clipped.
const MaxGroupDMNameLen = 100

// CreateGroupDMResult holds the result of creating a group DM.
type CreateGroupDMResult struct {
	Channel      *db.Channel
	Participants []db.DMUser
	// ParticipantIDs is every member including the creator, which is the set
	// the caller fans dm_channel_open out to.
	ParticipantIDs []int64
}

// CreateGroupDM creates a group DM between the caller and 2..8 other users
// (3..10 total, matching db.MaxGroupDMParticipants).
//
// Blocks are enforced in both directions, per recipient: a user cannot pull
// someone they have blocked into a room with them, and cannot use a group to
// reach someone who blocked them. The check is deliberately *creation-time
// only* — once the group exists, sending into it is not block-checked, because
// a group DM is a shared room and silently dropping one member's messages for
// one other member would make the conversation lie to everybody in it. That is
// also why the composer gate on the client applies to 1:1 DMs alone.
//
// Unlike CreateDM this always creates a new channel: the same set of people may
// want more than one group, so there is no "the group for these users" to find.
func (s *DMService) CreateGroupDM(ctx context.Context, userID int64, recipientIDs []int64, name string) (*CreateGroupDMResult, error) {
	ctx, span := telemetry.GlobalTracer("service/dm").Start(ctx, "DMService.CreateGroupDM",
		telemetry.Int64("user_id", userID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "CreateGroupDM"))
		span.End()
	}()

	// De-duplicate and drop the caller: a payload naming the same person twice
	// is a client bug, not a reason to refuse, but it must not inflate the
	// participant count or double-insert.
	seen := map[int64]bool{userID: true}
	unique := make([]int64, 0, len(recipientIDs))
	for _, rid := range recipientIDs {
		if rid <= 0 {
			return nil, fmt.Errorf("%w: recipient_ids must be positive", ErrBadRequest)
		}
		if seen[rid] {
			continue
		}
		seen[rid] = true
		unique = append(unique, rid)
	}

	if len(unique) < 2 {
		return nil, fmt.Errorf("%w: a group DM needs at least 2 other users", ErrBadRequest)
	}
	if len(unique)+1 > db.MaxGroupDMParticipants {
		return nil, fmt.Errorf("%w: a group DM holds at most %d users", ErrBadRequest, db.MaxGroupDMParticipants)
	}

	cleanName := cleanText(name)
	if utf8.RuneCountInString(cleanName) > MaxGroupDMNameLen {
		return nil, fmt.Errorf("%w: name must be at most %d characters", ErrBadRequest, MaxGroupDMNameLen)
	}

	for _, rid := range unique {
		user, err := s.st.GetUserByID(ctx, rid)
		if err != nil || user == nil {
			return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
		}
		blocked, err := s.st.IsEitherBlocked(ctx, userID, rid)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to check block status: %v", ErrInternal, err)
		}
		if blocked {
			return nil, fmt.Errorf("%w: cannot add a blocked user to a group DM", ErrForbidden)
		}
	}

	participantIDs := append([]int64{userID}, unique...)
	ch, err := s.st.CreateGroupDMChannel(ctx, cleanName, participantIDs)
	if err != nil {
		slog.Error("DMService.CreateGroupDM", "err", err)
		return nil, fmt.Errorf("%w: failed to create group DM", ErrInternal)
	}

	participants, err := s.st.GetDMParticipants(ctx, ch.ID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read group DM participants: %v", ErrInternal, err)
	}

	return &CreateGroupDMResult{
		Channel:        ch,
		Participants:   participants,
		ParticipantIDs: participantIDs,
	}, nil
}

// RenameGroupDM sets (or, with an empty name, clears) a group DM's name.
//
// Any participant may rename it, which is Discord's rule and the only one that
// works here: a group DM has no owner column and no roles, so "who may rename"
// has exactly one answer that does not require inventing an ownership model.
// A 1:1 DM refuses — its name is who is in it.
func (s *DMService) RenameGroupDM(ctx context.Context, userID, channelID int64, name string) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}

	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM kind: %v", ErrInternal, err)
	}
	if !isGroup {
		return nil, fmt.Errorf("%w: only group DMs can be named", ErrBadRequest)
	}

	cleanName := cleanText(name)
	if utf8.RuneCountInString(cleanName) > MaxGroupDMNameLen {
		return nil, fmt.Errorf("%w: name must be at most %d characters", ErrBadRequest, MaxGroupDMNameLen)
	}

	if err := s.st.SetDMChannelName(ctx, channelID, cleanName); err != nil {
		return nil, fmt.Errorf("%w: failed to rename group DM: %v", ErrInternal, err)
	}

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return ch, nil
}

// DMSummaryFor returns one DM's payload shape as viewerID sees it: the group
// name, the participants other than them, and whether it is a group.
//
// Every push of a DM's membership — group create, rename, leave — goes through
// it, so the shape a client receives from an event is the same one it receives
// from GET /dms and from `ready`. Membership is checked here rather than by
// each caller.
func (s *DMService) DMSummaryFor(ctx context.Context, viewerID, channelID int64) (db.DMChannelInfo, error) {
	ok, err := s.st.IsDMParticipant(ctx, viewerID, channelID)
	if err != nil || !ok {
		return db.DMChannelInfo{}, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	participants, err := s.st.GetDMParticipants(ctx, channelID, viewerID)
	if err != nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: failed to read DM participants: %v", ErrInternal, err)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: failed to read DM kind: %v", ErrInternal, err)
	}
	return db.NewDMChannelInfo(channelID, ch.Name, isGroup, participants, viewerID), nil
}

// RingTargets returns the other participants of a DM the caller is in — the
// people a call_ring or call_decline is addressed to.
//
// Ringing carries no state: a "call" in a DM *is* somebody being present in
// that DM's voice channel, and the ring is a nudge to come look. That is why
// this is a permission check and a fan-out list rather than a call record —
// there is nothing to persist that presence does not already say, and a
// persisted call would be one more thing that can be left dangling by a crash.
func (s *DMService) RingTargets(ctx context.Context, userID, channelID int64) ([]int64, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM participation: %v", ErrInternal, err)
	}
	if !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrForbidden)
	}
	// A ring is a DM interaction like any other sink: without this check a
	// blocked user could still make the blocker's client ring (A-2026-08-03).
	// Group DMs are exempt inside requireDMNotBlocked, matching every other
	// sink — blocks are enforced at group creation instead.
	if err := requireDMNotBlocked(ctx, s.st, userID, channelID); err != nil {
		return nil, err
	}

	ids, err := s.st.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM participants: %v", ErrInternal, err)
	}
	targets := make([]int64, 0, len(ids))
	for _, pid := range ids {
		if pid != userID {
			targets = append(targets, pid)
		}
	}
	return targets, nil
}
