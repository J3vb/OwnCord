package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// StartCallLogWorker recovers calls a previous run left open, then starts the
// worker loop. The composition root calls it once, after the hub and the event
// persister are up and before the router listens; ctx is the worker's
// lifecycle context. The returned func stops the loop, waits for it to exit
// and stamps last_seen_at on every call that still has someone in it, so the
// next boot ends those calls at shutdown time. A second call is a no-op.
func (s *CallLogService) StartCallLogWorker(ctx context.Context) func(context.Context) {
	s.callLogMu.Lock()
	if s.running {
		s.callLogMu.Unlock()
		return func(context.Context) {}
	}
	s.callLogMu.Unlock()

	// ClearAllVoiceStates already ran at boot, so nobody can be in a call yet:
	// every open row is a leftover and ends at the last time it was seen.
	s.recoverOpenCalls(ctx)

	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	s.callLogMu.Lock()
	s.running = true
	s.callLogMu.Unlock()
	go s.loop(ctx)

	return func(stopCtx context.Context) {
		s.callLogMu.Lock()
		s.running = false
		s.callLogMu.Unlock()
		s.stopOnce.Do(func() { close(s.stop) })
		select {
		case <-s.done:
		case <-stopCtx.Done():
			return
		}
		s.stampLastSeen(stopCtx)
	}
}

// loop is the only goroutine that reconciles while the worker runs. It exits
// when ctx is done or the stop func closes s.stop.
func (s *CallLogService) loop(ctx context.Context) {
	defer close(s.done)
	tick := time.NewTicker(s.tick)
	defer tick.Stop()
	grace := time.NewTimer(time.Hour)
	defer grace.Stop()
	armGrace := func() {
		if !grace.Stop() {
			select {
			case <-grace.C:
			default:
			}
		}
		if next := s.nextGraceDeadline(); !next.IsZero() {
			grace.Reset(max(next.Sub(s.now()), 0))
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-s.wake:
			if !s.sleep(ctx, s.coalesce) {
				return
			}
			s.reconcileDirty(ctx)
		case <-tick.C:
			s.reconcileAll(ctx)
		case <-grace.C:
			s.reconcileDue(ctx)
		}
		armGrace()
	}
}

// sleep waits d, reporting false when the worker was told to exit first.
func (s *CallLogService) sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	case <-s.stop:
		return false
	}
}

// reconcileDirty reconciles every channel a note touched since the last pass.
func (s *CallLogService) reconcileDirty(ctx context.Context) {
	for _, ch := range sortedChannels(s.takeDirty()) {
		s.reconcileTaken(ctx, ch.id, ch.p)
	}
}

// reconcileAll is the periodic pass: every dirty channel and every channel
// with a live call, once each.
func (s *CallLogService) reconcileAll(ctx context.Context) {
	dirty := s.takeDirty()
	open, err := s.st.ListOpenCalls(ctx)
	if err != nil {
		slog.Warn("call log: list open calls", "err", err)
	}
	for _, c := range open {
		if _, ok := dirty[c.ChannelID]; !ok {
			dirty[c.ChannelID] = nil
		}
	}
	for _, ch := range sortedChannels(dirty) {
		s.reconcileTaken(ctx, ch.id, ch.p)
	}
}

// reconcileDue reconciles the channels whose grace period has run out.
func (s *CallLogService) reconcileDue(ctx context.Context) {
	for _, ch := range s.graceDue(s.now()) {
		s.reconcileTaken(ctx, ch, nil)
	}
}

type channelPending struct {
	id int64
	p  *callLogPending
}

func sortedChannels(m map[int64]*callLogPending) []channelPending {
	out := make([]channelPending, 0, len(m))
	for id, p := range m {
		out = append(out, channelPending{id: id, p: p})
	}
	slices.SortFunc(out, func(a, b channelPending) int { return int(a.id - b.id) })
	return out
}

// reconcileTaken reconciles one channel and, on a store error, puts its notes
// back for the next pass.
func (s *CallLogService) reconcileTaken(ctx context.Context, channelID int64, p *callLogPending) {
	if err := s.reconcile(ctx, channelID, p); err != nil {
		slog.Warn("call log: reconcile", "err", err, "channel_id", channelID)
		s.requeue(channelID, p)
	}
}

// reconcile compares the channel's voice rows with its live call row and
// brings the row in line: start, record participants, refresh last_seen_at or
// end. p is the notes since the last pass (nil for a pass with none).
func (s *CallLogService) reconcile(ctx context.Context, channelID int64, p *callLogPending) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("get channel: %w", err)
	}
	if ch == nil || ch.Type != "dm" {
		s.dropState(channelID)
		return nil
	}
	states, err := s.st.GetChannelVoiceStates(ctx, channelID)
	if err != nil {
		return fmt.Errorf("voice states: %w", err)
	}
	open, err := s.st.GetOpenCall(ctx, channelID)
	if err != nil {
		return fmt.Errorf("open call: %w", err)
	}
	if open == nil {
		open, err = s.startCall(ctx, channelID, p, states)
		if err != nil || open == nil {
			return err
		}
	}
	return s.tendCall(ctx, open, p, states)
}

// roomJoined is every user who was in the room since the last pass: the
// joiners the notes recorded and the users with a voice row now.
func roomJoined(p *callLogPending, states []db.VoiceState) []int64 {
	set := make(map[int64]struct{}, len(states))
	for _, vs := range states {
		set[vs.UserID] = struct{}{}
	}
	if p != nil {
		for uid := range p.joiners {
			set[uid] = struct{}{}
		}
	}
	out := make([]int64, 0, len(set))
	for uid := range set {
		out = append(out, uid)
	}
	slices.Sort(out)
	return out
}

// firstJoiner picks the call's author and start: the earliest note (ties: the
// lowest user id), or with no notes the earliest voice row.
func firstJoiner(p *callLogPending, states []db.VoiceState, now time.Time) (int64, time.Time) {
	var author int64
	var at time.Time
	better := func(uid int64, t time.Time) bool {
		return author == 0 || t.Before(at) || (t.Equal(at) && uid < author)
	}
	if p != nil {
		for uid, t := range p.joiners {
			if better(uid, t) {
				author, at = uid, t
			}
		}
	}
	if author != 0 {
		return author, at
	}
	for _, vs := range states {
		t, ok := voiceJoinTime(vs.JoinedAt)
		if !ok {
			t = now
		}
		if better(vs.UserID, t) {
			author, at = vs.UserID, t
		}
	}
	return author, at
}

// startCall writes the row for a room that just filled, when there is one and
// the DM is allowed to carry it. It returns the live row to tend, or nil when
// there is nothing to tend.
func (s *CallLogService) startCall(ctx context.Context, channelID int64, p *callLogPending, states []db.VoiceState) (*db.OpenCall, error) {
	joined := roomJoined(p, states)
	if len(joined) == 0 {
		s.setSuppressed(channelID, false)
		s.clearEmptySince(channelID)
		return nil, nil
	}
	if s.isSuppressed(channelID) {
		if len(states) == 0 {
			s.setSuppressed(channelID, false)
		}
		return nil, nil
	}
	now := s.now()
	author, startedAt := firstJoiner(p, states, now)
	isGroup, targets, err := s.st.GetDMDeliveryTargets(ctx, channelID, author)
	if err != nil || !callLogAllowed(isGroup, targets, author) {
		// A lookup error fails closed, the same as a recipient who has not
		// accepted the author: no row, until the room has been empty.
		s.setSuppressed(channelID, true)
		if err != nil {
			slog.Warn("call log: delivery targets", "err", err, "channel_id", channelID)
		}
		return nil, nil
	}
	audience := dmDeliveryAudience(isGroup, targets, author)
	row, err := s.st.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: channelID, AuthorID: author, Content: callLiveContent,
		StartedAt: formatCallTime(startedAt), LastSeenAt: formatCallTime(now),
		ParticipantIDs: joined,
	})
	if errors.Is(err, db.ErrConflict) {
		// A row already exists: tend it instead.
		return s.st.GetOpenCall(ctx, channelID)
	}
	if err != nil {
		return nil, fmt.Errorf("create call log: %w", err)
	}
	s.announceCreated(ctx, row, audience)
	return &db.OpenCall{
		MessageID: row.Message.ID, ChannelID: channelID, AuthorID: author,
		StartedAt: row.Call.StartedAt, LastSeenAt: formatCallTime(now),
	}, nil
}

// callLogAllowed is the one-to-one acceptance gate: a one-to-one call is
// logged once the other participant has accepted the author (the
// message-request rule). A group DM has no such gate.
func callLogAllowed(isGroup bool, targets []db.DMDeliveryTarget, author int64) bool {
	if isGroup {
		return true
	}
	for _, t := range targets {
		if t.UserID != author && !t.TrustsSender {
			return false
		}
	}
	return true
}

// announceCreated reopens the DM for recipients who had closed it, then hands
// the row to the sink. The reopen payloads are built first so a client has the
// channel before the row arrives.
func (s *CallLogService) announceCreated(ctx context.Context, row *db.CallLogRow, audience []int64) {
	sink := s.loadSink()
	m := row.Message
	var reopens []RingReopen
	if s.dms != nil {
		recipients := make([]int64, 0, len(audience))
		for _, uid := range audience {
			if uid != m.UserID {
				recipients = append(recipients, uid)
			}
		}
		reopens = s.dms.OpenForRing(ctx, m.ChannelID, recipients)
	}
	if sink == nil {
		return
	}
	author, err := s.st.GetUserByID(ctx, m.UserID)
	if err != nil || author == nil {
		slog.Warn("call log: author lookup", "err", err, "channel_id", m.ChannelID)
		return
	}
	roleName := ""
	if role, rErr := s.st.GetRoleByID(ctx, author.RoleID); rErr == nil && role != nil {
		roleName = role.Name
	}
	sink.CallLogCreated(ctx, CallLogEvent{
		MessageID: m.ID, ChannelID: m.ChannelID, Author: author, AuthorRole: roleName,
		Content: m.Content, Timestamp: m.Timestamp, Call: row.Call,
		Audience: audience, Reopens: reopens,
	})
}

// tendCall keeps a live row in step with the room: it records participants
// (not broadcast), refreshes last_seen_at while someone is present, and ends
// the call once the room has been empty for the grace period.
func (s *CallLogService) tendCall(ctx context.Context, open *db.OpenCall, p *callLogPending, states []db.VoiceState) error {
	if err := s.st.AddCallParticipants(ctx, open.MessageID, roomJoined(p, states)); err != nil {
		return fmt.Errorf("record participants: %w", err)
	}
	now := s.now()
	if len(states) > 0 {
		s.clearEmptySince(open.ChannelID)
		return s.refreshLastSeen(ctx, open, now)
	}
	since, ok := s.getEmptySince(open.ChannelID)
	if p != nil && p.lastLeave.After(since) {
		since, ok = p.lastLeave, true
	}
	if !ok {
		since = now
	}
	s.setEmptySince(open.ChannelID, since)
	if now.Sub(since) < s.grace {
		return nil
	}
	return s.endCall(ctx, open, since)
}

// refreshLastSeen advances last_seen_at once it is half a tick old, so after a
// crash it is never much more than one tick behind.
func (s *CallLogService) refreshLastSeen(ctx context.Context, open *db.OpenCall, now time.Time) error {
	if seen, ok := parseCallTime(open.LastSeenAt); ok && now.Sub(seen) < s.tick/2 {
		return nil
	}
	if err := s.st.TouchCall(ctx, open.MessageID, formatCallTime(now)); err != nil {
		return fmt.Errorf("touch call: %w", err)
	}
	return nil
}

// endCall closes a live call at endAt (clamped to its start), rewrites the
// fallback text and hands the ended row to the sink. Ending twice does
// nothing: only the call that ended it is announced.
func (s *CallLogService) endCall(ctx context.Context, open *db.OpenCall, endAt time.Time) error {
	if started, ok := parseCallTime(open.StartedAt); ok && endAt.Before(started) {
		endAt = started
	}
	var length time.Duration
	if started, ok := parseCallTime(open.StartedAt); ok {
		length = endAt.Sub(started)
	}
	content := callEndedContent(length)
	ended, err := s.st.EndCall(ctx, open.MessageID, formatCallTime(endAt), content)
	if err != nil {
		return fmt.Errorf("end call: %w", err)
	}
	s.clearEmptySince(open.ChannelID)
	if !ended {
		return nil
	}
	s.announceEnded(ctx, open, content)
	return nil
}

func (s *CallLogService) announceEnded(ctx context.Context, open *db.OpenCall, content string) {
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
	sink.CallLogEnded(ctx, CallLogEvent{
		MessageID: open.MessageID, ChannelID: open.ChannelID, Content: content,
		Call: *info, Audience: dmDeliveryAudience(isGroup, targets, open.AuthorID),
	})
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

// stampLastSeen records "someone is here now" on every live call that still
// has a participant present, so the next boot ends it at shutdown time. A
// database write only; nothing is broadcast.
func (s *CallLogService) stampLastSeen(ctx context.Context) {
	open, err := s.st.ListOpenCalls(ctx)
	if err != nil {
		slog.Warn("call log: stop list", "err", err)
		return
	}
	now := formatCallTime(s.now())
	for _, c := range open {
		states, err := s.st.GetChannelVoiceStates(ctx, c.ChannelID)
		if err != nil || len(states) == 0 {
			continue
		}
		if err := s.st.TouchCall(ctx, c.MessageID, now); err != nil {
			slog.Warn("call log: stop stamp", "err", err, "message_id", c.MessageID)
		}
	}
}
