package service

import (
	"context"
	"log/slog"

	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// RingReopen is one DM reopened for a ring target, with the payload the
// dm_channel_open announcing it carries.
type RingReopen struct {
	UserID  int64
	Summary db.DMChannelInfo
}

// OpenForRing reopens the DM for every ring target who had closed it and returns
// each reopen with its dm_channel_open payload, for the caller to announce ahead of
// call_incoming: otherwise a callee who closed the DM accepts a call into a channel
// their client does not have. OpenDM is idempotent and reports a genuine (re)open,
// so an already-open DM returns nothing (see SendMessage).
// The payload is built before the row is written: a reopen that could not be
// announced would persist, and every later ring would see the DM open and never
// announce it. A failure on either step skips that target (logged); the ring must
// still go out.
func (s *DMService) OpenForRing(ctx context.Context, channelID int64, targets []int64) []RingReopen {
	var reopened []RingReopen
	for _, pid := range targets {
		summary, err := s.DMSummaryFor(ctx, pid, channelID)
		if err != nil {
			slog.Warn("DMService.OpenForRing summary", "err", err, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		ok, err := s.st.OpenDMIfParticipant(ctx, pid, channelID)
		if err != nil {
			slog.Warn("DMService.OpenForRing OpenDM", "err", err, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		if ok {
			reopened = append(reopened, RingReopen{UserID: pid, Summary: summary})
		}
	}
	s.withHistory(ctx, channelID, reopened)
	return reopened
}

// withHistory fills in what DMSummaryFor leaves at zero (last message, unread and
// mention counts) for every reopen, from one read for the channel. A ring sends no
// chat frame to repair a bare row, so the reopen carries it. On a failed read the
// bare summaries still announce the DM.
func (s *DMService) withHistory(ctx context.Context, channelID int64, reopened []RingReopen) {
	if len(reopened) == 0 {
		return
	}
	ids := make([]int64, len(reopened))
	for i := range reopened {
		ids[i] = reopened[i].UserID
	}
	history, err := s.st.GetDMHistoryForParticipants(ctx, channelID, ids)
	if err != nil {
		slog.Warn("DMService.OpenForRing history", "err", err, "channel_id", channelID)
		return
	}
	for i := range reopened {
		h, ok := history[reopened[i].UserID]
		if !ok {
			continue
		}
		sum := &reopened[i].Summary
		sum.LastMessageID = h.LastMessageID
		sum.LastMessage = h.LastMessage
		sum.LastMessageAt = h.LastMessageAt
		sum.UnreadCount = h.UnreadCount
		sum.MentionCount = h.MentionCount
	}
}

// SharedOneToOneDM returns the 1:1 DM channel the two users share, or ok=false.
// Group DMs never match (RequireDMReachable exempts groups).
func (s *DMService) SharedOneToOneDM(ctx context.Context, userA, userB int64) (int64, bool, error) {
	id, ok, err := s.st.FindDMChannelIDBetween(ctx, userA, userB)
	if err != nil {
		return 0, false, fmt.Errorf("%w: failed to look up shared DM: %w", ErrInternal, err)
	}
	return id, ok, nil
}

// RingTargets returns the other participants of a DM the caller is in, the people
// a call_ring is addressed to. A timed-out caller is refused, as for a send.
// Ringing carries no state: a "call" in a DM is somebody present in its voice
// channel and the ring a nudge, so there is nothing to persist that presence does
// not say, and a persisted call could dangle after a crash.
func (s *DMService) RingTargets(ctx context.Context, userID, channelID int64) ([]int64, error) {
	return s.callTargets(ctx, userID, channelID, true)
}

// DeclineTargets is RingTargets for a call_decline. A decline carries no text and
// only stops the ringer's client ringing, so a timeout does not refuse it.
func (s *DMService) DeclineTargets(ctx context.Context, userID, channelID int64) ([]int64, error) {
	return s.callTargets(ctx, userID, channelID, false)
}

func (s *DMService) callTargets(ctx context.Context, userID, channelID int64, ring bool) ([]int64, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM participation: %w", ErrInternal, err)
	}
	if !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrForbidden)
	}
	// A ring is a DM interaction like any other sink: without this a blocked user
	// could make the blocker's client ring. Groups are exempt inside
	// RequireDMReachable; blocks are enforced at group creation instead.
	if err := RequireDMReachable(ctx, storeDMReader{s.st}, userID, channelID); err != nil {
		return nil, err
	}
	if ring {
		if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
			return nil, err
		}
	}

	ids, err := s.st.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM participants: %w", ErrInternal, err)
	}

	// call_incoming/call_declined is a DM interaction like chat and typing: an
	// untrusted recipient of a pending request must not learn the sender is in voice.
	// Groups are untouched. A failed IsGroupDM must fail closed to no ring targets,
	// not an unfiltered ring.
	isGroup, gErr := s.st.IsGroupDM(ctx, channelID)
	if gErr != nil {
		return nil, nil //nolint:nilerr // fail closed to no targets, not an error — the ringer's own call_ring must still succeed
	}

	targets := make([]int64, 0, len(ids))
	for _, pid := range ids {
		if pid == userID {
			continue
		}
		if !isGroup {
			trusted, tErr := s.st.IsTrustedSender(ctx, pid, userID)
			if tErr == nil && !trusted && ring {
				// Tell the ringer at once rather than let them wait out a ring nobody will hear.
				// A decline stays silent.
				return nil, ErrCallNeedsAcceptance
			}
			if tErr != nil || !trusted {
				continue
			}
		}
		targets = append(targets, pid)
	}
	return targets, nil
}
