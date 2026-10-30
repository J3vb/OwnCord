package service

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// StartCallLogWorker recovers calls a previous run left open, then starts the
// worker loop. The composition root calls it once, after the hub and event
// persister are up and before the router listens; ctx is the worker's lifecycle
// context. The returned func stops the loop, waits for it and stamps last_seen_at
// on every call still occupied (or in its end grace), so the next boot ends those
// calls at shutdown time. A Start while a worker runs is a no-op; after a stop it
// runs a fresh worker.
func (s *CallLogService) StartCallLogWorker(ctx context.Context) func(context.Context) {
	s.callLogMu.Lock()
	if s.running {
		s.callLogMu.Unlock()
		return func(context.Context) {}
	}
	s.running = true
	prev := s.done
	stop := make(chan struct{})
	done := make(chan struct{})
	s.done = done
	s.callLogMu.Unlock()

	// A previous loop whose stop gave up waiting may still be finishing. Wait for it
	// so two loops never overlap and recovery cannot end a call that loop still
	// tends. If ctx ends first, this Start does not run.
	if prev != nil {
		select {
		case <-prev:
		case <-ctx.Done():
			s.callLogMu.Lock()
			s.running = false
			s.done = prev
			s.callLogMu.Unlock()
			return func(context.Context) {}
		}
	}

	// ClearAllVoiceStates already ran at boot, so nobody can be in a call yet:
	// every open row is a leftover and ends at the last time it was seen.
	s.recoverOpenCalls(ctx)
	go s.loop(ctx, stop, done)

	var once sync.Once
	return func(stopCtx context.Context) {
		once.Do(func() {
			s.callLogMu.Lock()
			s.running = false
			s.callLogMu.Unlock()
			close(stop)
			select {
			case <-done:
			case <-stopCtx.Done():
				return
			}
			s.stampLastSeen(stopCtx)
		})
	}
}

// loop is the only goroutine that reconciles while the worker runs. It exits
// when ctx is done or stop is closed.
func (s *CallLogService) loop(ctx context.Context, stop, done chan struct{}) {
	defer close(done)
	tick := time.NewTicker(s.tick)
	defer tick.Stop()
	timed := time.NewTimer(time.Hour)
	defer timed.Stop()
	arm := func() {
		if !timed.Stop() {
			select {
			case <-timed.C:
			default:
			}
		}
		if next := s.nextDue(); !next.IsZero() {
			timed.Reset(max(next.Sub(s.now()), 0))
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-s.wake:
			if !sleepOrExit(ctx, stop, s.coalesce) {
				return
			}
			s.reconcileDirty(ctx)
		case <-tick.C:
			s.reconcileAll(ctx)
		case <-timed.C:
			s.reconcileDue(ctx)
		}
		arm()
	}
}

// sleepOrExit waits d, reporting false when the worker was told to exit first.
func sleepOrExit(ctx context.Context, stop <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	case <-stop:
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

// reconcileDue reconciles the channels with timed work due: a grace period
// that has run out or a retry delay that has passed. A note still waiting in
// the channel's dirty entry is taken along, so it cannot open a second row
// after an end.
func (s *CallLogService) reconcileDue(ctx context.Context) {
	for _, ch := range s.dueChannels(s.now()) {
		s.reconcileTaken(ctx, ch, s.takeDirtyFor(ch))
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
	slices.SortFunc(out, func(a, b channelPending) int { return cmp.Compare(a.id, b.id) })
	return out
}

// reconcileTaken reconciles one channel. A channel still backing off from a
// failure is left alone with its notes put back; a failure puts the notes back
// and backs the channel off, so the next attempt is on a growing delay.
func (s *CallLogService) reconcileTaken(ctx context.Context, channelID int64, p *callLogPending) {
	if s.inBackoff(channelID) {
		s.requeue(channelID, p)
		return
	}
	if err := s.reconcile(ctx, channelID, p); err != nil {
		slog.Warn("call log: reconcile", "err", err, "channel_id", channelID)
		s.noteFailure(channelID)
		s.requeue(channelID, p)
		return
	}
	s.clearRetry(channelID)
}

// reconcile compares the channel's voice rows with its live call row and
// brings the row in line: start, record participants, refresh last_seen_at or
// end. The voice rows tell only whether the room is occupied; who joined comes
// from the completion notes in p (nil for a pass with none).
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
	occupied := len(states) > 0
	if open == nil {
		open, err = s.startCall(ctx, channelID, p, occupied)
		if err != nil || open == nil {
			return err
		}
	}
	return s.tendCall(ctx, open, p, occupied)
}

// joiner is a user whose completed join was noted, with the time of the note.
type joiner struct {
	id int64
	at time.Time
}

// liveJoiners returns the noted joiners who still exist, earliest first (ties:
// the lowest user id). A vanished user is dropped from p so a retry does not
// carry it again.
func (s *CallLogService) liveJoiners(ctx context.Context, p *callLogPending) ([]joiner, error) {
	if p == nil {
		return nil, nil
	}
	out := make([]joiner, 0, len(p.joiners))
	for uid, at := range p.joiners {
		u, err := s.st.GetUserByID(ctx, uid)
		if err != nil {
			return nil, fmt.Errorf("user %d: %w", uid, err)
		}
		if u == nil {
			delete(p.joiners, uid)
			continue
		}
		out = append(out, joiner{id: uid, at: at})
	}
	slices.SortFunc(out, func(a, b joiner) int {
		if c := a.at.Compare(b.at); c != 0 {
			return c
		}
		return cmp.Compare(a.id, b.id)
	})
	return out, nil
}

// startCall writes the row for a room that just filled, when someone's join
// was noted and the DM is allowed to carry it. It returns the live row to
// tend, or nil when there is nothing to tend.
func (s *CallLogService) startCall(ctx context.Context, channelID int64, p *callLogPending, occupied bool) (*db.OpenCall, error) {
	s.clearEmptySince(channelID)
	joiners, err := s.liveJoiners(ctx, p)
	if err != nil {
		return nil, err
	}
	if len(joiners) == 0 || s.isSuppressed(channelID) {
		if !occupied {
			s.setSuppressed(channelID, false)
		}
		return nil, nil
	}
	author, startedAt := joiners[0].id, joiners[0].at
	ok, audience, err := s.callAllowed(ctx, channelID, author)
	if err != nil {
		// A failed lookup writes no row and is retried on the channel's
		// backoff with its notes kept, so one busy read does not lose the call.
		return nil, fmt.Errorf("call allowed: %w", err)
	}
	if !ok {
		// Not accepted by both sides: no row until the room has been empty.
		s.setSuppressed(channelID, true)
		return nil, nil
	}
	ids := make([]int64, 0, len(joiners))
	for _, j := range joiners {
		ids = append(ids, j.id)
	}
	slices.Sort(ids)
	now := s.now()
	row, err := s.st.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: channelID, AuthorID: author, Content: callLiveContent,
		StartedAt: formatCallTime(startedAt), LastSeenAt: formatCallTime(now),
		ParticipantIDs: ids,
	})
	if errors.Is(err, db.ErrConflict) {
		// A row already exists: tend it instead.
		return s.st.GetOpenCall(ctx, channelID)
	}
	if err != nil {
		return nil, fmt.Errorf("create call log: %w", err)
	}
	s.setAudience(row.Message.ID, audience)
	s.markRecorded(row.Message.ID, ids)
	s.announceCreated(ctx, row, audience)
	return &db.OpenCall{
		MessageID: row.Message.ID, ChannelID: channelID, AuthorID: author,
		StartedAt: row.Call.StartedAt, LastSeenAt: formatCallTime(now),
	}, nil
}

// callAllowed is the acceptance gate for logging a call: a one-to-one call is
// logged once both people have accepted the DM, each trusting the other. A
// group DM has no such condition. It also returns the audience the author's
// frames go to. Any lookup error fails closed.
func (s *CallLogService) callAllowed(ctx context.Context, channelID, author int64) (bool, []int64, error) {
	isGroup, targets, err := s.st.GetDMDeliveryTargets(ctx, channelID, author)
	if err != nil {
		return false, nil, fmt.Errorf("delivery targets: %w", err)
	}
	audience := dmDeliveryAudience(isGroup, targets, author)
	if isGroup {
		return true, audience, nil
	}
	for _, t := range targets {
		if t.UserID == author {
			continue
		}
		if !t.TrustsSender {
			return false, nil, nil
		}
		back, err := s.st.IsTrustedSender(ctx, author, t.UserID)
		if err != nil {
			return false, nil, fmt.Errorf("trust lookup: %w", err)
		}
		if !back {
			return false, nil, nil
		}
	}
	return true, audience, nil
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
	// If the author cannot be read the row still goes out with the id alone,
	// so the frame that ends it has a row to update.
	author := &db.User{ID: m.UserID}
	roleName := ""
	if u, err := s.st.GetUserByID(ctx, m.UserID); err == nil && u != nil {
		author = u
		if role, rErr := s.st.GetRoleByID(ctx, u.RoleID); rErr == nil && role != nil {
			roleName = role.Name
		}
	} else {
		slog.Warn("call log: author lookup", "err", err, "channel_id", m.ChannelID)
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
func (s *CallLogService) tendCall(ctx context.Context, open *db.OpenCall, p *callLogPending, occupied bool) error {
	if err := s.recordParticipants(ctx, open, p); err != nil {
		return err
	}
	now := s.now()
	if occupied {
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

// recordParticipants writes the joiners the notes name that are not recorded
// yet. An unchanged room costs no write. In a one-to-one DM the acceptance gate
// is checked again first, so a participant is never added once it no longer
// holds.
func (s *CallLogService) recordParticipants(ctx context.Context, open *db.OpenCall, p *callLogPending) error {
	if p == nil || len(p.joiners) == 0 {
		return nil
	}
	have := s.recordedSet(open.MessageID)
	var fresh []int64
	for uid := range p.joiners {
		if _, ok := have[uid]; !ok {
			fresh = append(fresh, uid)
		}
	}
	if len(fresh) == 0 {
		return nil
	}
	slices.Sort(fresh)
	ok, _, err := s.callAllowed(ctx, open.ChannelID, open.AuthorID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if err := s.st.AddCallParticipants(ctx, open.MessageID, fresh); err != nil {
		return fmt.Errorf("record participants: %w", err)
	}
	s.markRecorded(open.MessageID, fresh)
	return nil
}

// refreshLastSeen advances last_seen_at once it is half a tick old, so after a
// crash it is never much more than one tick stale.
func (s *CallLogService) refreshLastSeen(ctx context.Context, open *db.OpenCall, now time.Time) error {
	if seen, ok := parseCallTime(open.LastSeenAt); ok && now.Sub(seen) < s.tick/2 {
		return nil
	}
	if err := s.st.TouchCall(ctx, open.MessageID, formatCallTime(now)); err != nil {
		return fmt.Errorf("touch call: %w", err)
	}
	return nil
}
