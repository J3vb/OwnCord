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

// StartCallLogWorker recovers calls a previous run left open, then starts the worker. Call
// once after the hub and event persister are up and before the router listens. The
// returned func stops the loop and stamps last_seen_at on occupied calls. Idempotent while running.
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

	// A previous loop whose stop gave up waiting may still be finishing. Wait so two loops
	// never overlap and recovery cannot end a call that loop still tends. If ctx ends first,
	// this Start does not run.
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

	// ClearAllVoiceStates already ran at boot, so every open row is a leftover and ends at
	// the last time it was seen.
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

func (s *CallLogService) reconcileDirty(ctx context.Context) {
	for _, ch := range sortedChannels(s.takeDirty()) {
		s.reconcileTaken(ctx, ch.id, ch.p)
	}
}

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

// reconcileTaken reconciles one channel. A channel still backing off is left alone with
// its notes put back; a failure puts them back and backs off on a growing delay.
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

// reconcile brings the live call row in line with the channel's voice rows: start, record
// participants, refresh last_seen_at or end. Voice rows only say whether the room is
// occupied; who joined comes from the notes in p (nil when none).
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

type joiner struct {
	id int64
	at time.Time
}

// liveJoiners returns the noted joiners who still exist, earliest first (ties: lowest user
// id). A vanished user is dropped from p so a retry does not carry it again.
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
		return nil, fmt.Errorf("call allowed: %w", err)
	}
	if !ok {
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

// callAllowed is the gate for logging a call: a one-to-one call is logged once both
// people have accepted the DM, each trusting the other; a group DM has no such condition.
// Also returns the audience of the author's frames. Any lookup error fails closed.
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
	// If the author cannot be read the row still goes out with the id alone, so the ending frame has a row to
	// update.
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

// recordParticipants writes joiners not yet recorded. In a one-to-one DM the acceptance
// gate is rechecked first, so a participant is never added once it no longer holds.
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

func (s *CallLogService) refreshLastSeen(ctx context.Context, open *db.OpenCall, now time.Time) error {
	if seen, ok := parseCallTime(open.LastSeenAt); ok && now.Sub(seen) < s.tick/2 {
		return nil
	}
	if err := s.st.TouchCall(ctx, open.MessageID, formatCallTime(now)); err != nil {
		return fmt.Errorf("touch call: %w", err)
	}
	return nil
}
