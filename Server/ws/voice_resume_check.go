package ws

// voice_resume_check.go: a voice membership a resumed socket takes over must be
// at the SFU.
//
// A socket that drops after its join completed (the token went out) but before
// the client reached the SFU is parked in the grace window, and a resume
// inherits it. A client that gave the call up while offline is idle on the new
// socket, so the row names a join nobody holds at the SFU: the user shows in
// the channel and counts toward its cap until the reconciler's second miss,
// 60 to 120 s later.
//
// So a resumed socket that holds a membership (grace inherit or old-socket
// transfer) gets a check voiceResumeCheckDelay later: the SFU is asked for that
// exact identity (user and join token). Present, the check is done. Absent, it
// looks again voiceResumeConfirmGap later, because the media path of a resumed
// socket is often recovering too: the client's own SFU retries run up to 15 s
// apart. Absent on both looks while the socket still holds that join, the
// membership ends through the normal leave tail, voice_leave to everyone
// including the owner. A join the socket no longer holds (left, moved,
// rejoined, dropped again) is someone else's to tear down, so the check just
// ends. A failed list is not "absent": it is retried next tick until
// voiceResumeCheckGiveUp past due, and the reconciler stays the backstop.

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	// voiceResumeCheckDelay is when the SFU is first asked for the resumed join.
	voiceResumeCheckDelay = 10 * time.Second
	// voiceResumeConfirmGap is how long after a first miss the second look runs.
	// Longer than the client's longest SFU retry step (15 s), so a call that is
	// reconnecting shows up on one of the two looks.
	voiceResumeConfirmGap = 20 * time.Second
	// voiceResumeCheckGiveUp bounds the retries of a check whose SFU list keeps
	// failing; the reconciler handles anything left.
	voiceResumeCheckGiveUp = 30 * time.Second
	// voiceResumeCheckInterval is how often due checks are run.
	voiceResumeCheckInterval = 2 * time.Second
	// voiceResumeCheckTimeout bounds one tick.
	voiceResumeCheckTimeout = 10 * time.Second
)

// resumeCheck is one pending check: the join a resumed socket took over.
type resumeCheck struct {
	userID    int64
	channelID int64
	token     string
	due       time.Time
	misses    int    // absent lists so far; the second ends the membership
	gen       uint64 // tells this check from a newer one for the same join
}

// voiceResumeChecks holds pending checks by user. A user has one voice row, so a
// newer resume replaces the older check.
type voiceResumeChecks struct {
	mu      syncutil.Ranked[lockRankLeaf]
	entries map[int64]resumeCheck
	gen     uint64
	now     func() time.Time // test seam; nil means time.Now
}

func (s *voiceResumeChecks) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// record schedules a check of userID's join (channelID, token). A join with no
// token cannot be named at the SFU, so it is not checked.
func (s *voiceResumeChecks) record(userID, channelID int64, token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[int64]resumeCheck{}
	}
	s.gen++
	s.entries[userID] = resumeCheck{userID: userID, channelID: channelID, token: token, due: s.clock().Add(voiceResumeCheckDelay), gen: s.gen}
}

// current reports whether e is still userID's check, not ended or replaced by a
// newer resume.
func (s *voiceResumeChecks) current(e resumeCheck) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.entries[e.userID]
	return ok && cur.gen == e.gen
}

// missed records a first absent list for e and schedules the second look;
// false when e is no longer current.
func (s *voiceResumeChecks) missed(e resumeCheck) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.entries[e.userID]
	if !ok || cur.gen != e.gen {
		return false
	}
	cur.misses++
	cur.due = s.clock().Add(voiceResumeConfirmGap)
	s.entries[e.userID] = cur
	return true
}

// pending reports whether any check is waiting.
func (s *voiceResumeChecks) pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries) > 0
}

// takeDue returns the due checks grouped by channel, dropping those past the
// give-up bound. The checks stay recorded until done ends them.
func (s *voiceResumeChecks) takeDue() map[int64][]resumeCheck {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	out := map[int64][]resumeCheck{}
	for uid, e := range s.entries {
		if now.Before(e.due) {
			continue
		}
		if now.Sub(e.due) > voiceResumeCheckGiveUp {
			delete(s.entries, uid)
			continue
		}
		out[e.channelID] = append(out[e.channelID], e)
	}
	return out
}

// done ends e if it is still current; a newer resume's check stays.
func (s *voiceResumeChecks) done(e resumeCheck) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.entries[e.userID]; ok && cur.gen == e.gen {
		delete(s.entries, e.userID)
	}
}

// noteResumedVoice schedules the check for a resumed socket that now holds a
// membership. registerNow calls it after the hub lock is released.
func (h *Hub) noteResumedVoice(c *Client) {
	if h.livekit == nil || c.lastSeq == 0 {
		return
	}
	if chID, token := c.voice.state(); chID != 0 {
		h.voiceResumeChecks.record(c.userID, chID, token)
	}
}

func (h *Hub) runVoiceResumeChecksLife() { h.runVoiceResumeChecks(h.lifeCtx()) }

// runVoiceResumeChecks runs due checks every voiceResumeCheckInterval until the
// hub stops. Run starts it once on h.sweeps, so Done waits for it; a tick with
// nothing pending does no work.
func (h *Hub) runVoiceResumeChecks(life context.Context) {
	if h.livekit == nil {
		return
	}
	ticker := time.NewTicker(voiceResumeCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-life.Done():
			return
		case <-h.stop:
			return
		case <-ticker.C:
			if !h.voiceResumeChecks.pending() {
				continue
			}
			ctx, cancel := context.WithTimeout(life, voiceResumeCheckTimeout)
			h.checkResumedVoice(ctx)
			cancel()
		}
	}
}

// checkResumedVoice runs every due check, one SFU list per channel.
func (h *Hub) checkResumedVoice(ctx context.Context) {
	for channelID, checks := range h.voiceResumeChecks.takeDue() {
		if ctx.Err() != nil {
			return
		}
		identities, err := h.livekit.ListParticipants(ctx, channelID)
		if err != nil {
			slog.Warn("voice resume check: ListParticipants failed, retrying next tick",
				"err", err, "channel_id", channelID)
			continue
		}
		present := make(map[string]struct{}, len(identities))
		for _, id := range identities {
			present[id] = struct{}{}
		}
		for _, e := range checks {
			if _, ok := present[participantIdentity(e.userID, e.token)]; ok {
				h.voiceResumeChecks.done(e)
				continue
			}
			if e.misses == 0 {
				h.voiceResumeChecks.missed(e)
				continue
			}
			h.endUnconfirmedVoice(ctx, e)
		}
	}
}

// endUnconfirmedVoice ends the membership e names when a live socket still
// holds exactly that join and e is still the current check. Otherwise nothing:
// whoever cleared it owns the teardown, a membership parked again belongs to
// the grace window, and a newer resume (recorded under the same member lock)
// carries its own check, whose lists postdate it.
func (h *Hub) endUnconfirmedVoice(ctx context.Context, e resumeCheck) {
	txn := h.begin(e.userID)
	defer txn.end()
	if !h.voiceResumeChecks.current(e) {
		return
	}
	h.voiceResumeChecks.done(e)
	for _, c := range h.clientsOf(e.userID) {
		if !txn.clearExact(c, e.channelID, e.token) {
			continue
		}
		tailCtx, cancelTail := h.sweepTailCtx(ctx)
		defer cancelTail()
		slog.Info("voice resume check: resumed membership never reached the SFU",
			"user_id", e.userID, "channel_id", e.channelID)
		h.finishVoiceLeave(tailCtx, txn, c, e.channelID, e.token, voiceLeaveReasonUnconfirmed)
		return
	}
}
