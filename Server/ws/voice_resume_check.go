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
// transfer) gets one check voiceResumeCheckDelay later: the SFU is asked for
// that exact identity (user and join token). Present, the check is done. Absent
// while the socket still holds that join, the membership ends through the
// normal leave tail, voice_leave to everyone including the owner. A join the
// socket no longer holds (left, moved, rejoined, dropped again) is someone
// else's to tear down, so the check just ends. A failed list is not "absent":
// it is retried next tick until voiceResumeCheckGiveUp past due, and the
// reconciler stays the backstop.

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceResumeCheckDelay is how long after a resume the SFU must show the
// inherited join. It covers a client finishing its SFU connect once the network
// is back. A var so tests can shrink it.
var voiceResumeCheckDelay = 10 * time.Second

const (
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
}

// voiceResumeChecks holds pending checks by user. A user has one voice row, so a
// newer resume replaces the older check.
type voiceResumeChecks struct {
	mu      syncutil.Ranked[lockRankLeaf]
	entries map[int64]resumeCheck
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
	s.entries[userID] = resumeCheck{userID: userID, channelID: channelID, token: token, due: s.clock().Add(voiceResumeCheckDelay)}
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

// done ends userID's check if it is still for token; a newer resume's check stays.
func (s *voiceResumeChecks) done(userID int64, token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.entries[userID]; ok && e.token == token {
		delete(s.entries, userID)
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
			if _, ok := present[participantIdentity(e.userID, e.token)]; !ok {
				h.endUnconfirmedVoice(ctx, e)
			}
			h.voiceResumeChecks.done(e.userID, e.token)
		}
	}
}

// endUnconfirmedVoice ends the membership e names when a live socket still
// holds exactly that join. Otherwise nothing: whoever cleared it owns the
// teardown, and a membership parked again belongs to the grace window.
func (h *Hub) endUnconfirmedVoice(ctx context.Context, e resumeCheck) {
	txn := h.begin(e.userID)
	defer txn.end()
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
