package service

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Ending a call, and the start-up and stop passes that settle live calls.

// endCall closes a live call at endAt (clamped to its start), rewrites the
// fallback text and hands the ended row to the sink. Ending twice does
// nothing: only the call that ended it is announced.
func (s *CallLogService) endCall(ctx context.Context, open *db.OpenCall, endAt time.Time) error {
	var length time.Duration
	if started, ok := parseCallTime(open.StartedAt); ok {
		endAt = laterOf(endAt, started)
		length = endAt.Sub(started)
	}
	content := callEndedContent(length)
	ended, err := s.st.EndCall(ctx, open.MessageID, formatCallTime(endAt), content)
	if err != nil {
		return fmt.Errorf("end call: %w", err)
	}
	s.clearEmptySince(open.ChannelID)
	startAudience := s.forgetCall(open.MessageID)
	if !ended {
		return nil
	}
	s.announceEnded(ctx, open, content, startAudience)
	return nil
}

func laterOf(a, b time.Time) time.Time {
	if a.Before(b) {
		return b
	}
	return a
}

// announceEnded hands the ended row to the sink. The audience is the current
// audience plus whoever the start went to and is still a participant, so a
// 1:1 participant whose trust changed mid-call still gets the end while a
// member who left or was removed from a group gets nothing more. A failed
// participant read announces nothing; the ended row is still stored.
func (s *CallLogService) announceEnded(ctx context.Context, open *db.OpenCall, content string, startAudience []int64) {
	sink := s.loadSink()
	if sink == nil {
		return
	}
	info, err := s.st.GetCallInfo(ctx, open.MessageID)
	if err != nil || info == nil {
		slog.Warn("call log: read ended call", "err", err, "message_id", open.MessageID)
		return
	}
	isGroup, targets, err := s.st.GetDMDeliveryTargets(ctx, open.ChannelID, open.AuthorID)
	if err != nil {
		slog.Warn("call log: delivery targets for end", "err", err, "channel_id", open.ChannelID)
		return
	}
	audience := endAudience(startAudience, isGroup, targets, open.AuthorID)
	if len(audience) == 0 {
		return
	}
	sink.CallLogEnded(ctx, CallLogEvent{
		MessageID: open.MessageID, ChannelID: open.ChannelID, Content: content,
		Call: *info, Audience: audience,
	})
}

// endAudience is the start audience narrowed to current participants, joined
// with the current delivery audience, sorted and without duplicates.
func endAudience(startAudience []int64, isGroup bool, targets []db.DMDeliveryTarget, authorID int64) []int64 {
	members := dmTargetIDs(targets)
	audience := dmDeliveryAudience(isGroup, targets, authorID)
	for _, id := range startAudience {
		if slices.Contains(members, id) {
			audience = append(audience, id)
		}
	}
	slices.Sort(audience)
	return slices.Compact(audience)
}

// recoverOpenCalls ends every call a previous run left open, at the time it
// was last seen occupied.
func (s *CallLogService) recoverOpenCalls(ctx context.Context) {
	open, err := s.st.ListOpenCalls(ctx)
	if err != nil {
		slog.Error("call log: recovery list", "err", err)
		return
	}
	for i := range open {
		seen, ok := parseCallTime(open[i].LastSeenAt)
		if !ok {
			seen = s.now()
		}
		if err := s.endCall(ctx, &open[i], seen); err != nil {
			slog.Error("call log: recovery end", "err", err, "message_id", open[i].MessageID)
		}
	}
}

// stampLastSeen records "someone was here" on every live call, so the next
// boot ends it at shutdown time: now for a call with someone present, and the
// moment the room emptied (or its leave note, still pending) for a call
// waiting out its end grace. A database
// write only; nothing is broadcast.
func (s *CallLogService) stampLastSeen(ctx context.Context) {
	open, err := s.st.ListOpenCalls(ctx)
	if err != nil {
		slog.Warn("call log: stop list", "err", err)
		return
	}
	for _, c := range open {
		states, err := s.st.GetChannelVoiceStates(ctx, c.ChannelID)
		if err != nil {
			continue
		}
		seen := s.now()
		if len(states) == 0 {
			since, ok := s.getEmptySince(c.ChannelID)
			if left := s.pendingLeave(c.ChannelID); left.After(since) {
				since, ok = left, true
			}
			if !ok {
				continue
			}
			seen = since
		}
		if err := s.st.TouchCall(ctx, c.MessageID, formatCallTime(seen)); err != nil {
			slog.Warn("call log: stop stamp", "err", err, "message_id", c.MessageID)
		}
	}
}
