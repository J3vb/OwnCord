package ws

// voice_removed_watch.go: a removed SFU identity stays removed. LiveKit tokens cannot be
// revoked (they lapse after tokenTTL), so every identity RemoveParticipant removes is
// remembered for tokenTTL, and a short tick lists those rooms and removes it again if
// present. Identities carry the join token, so a fresh join is never affected. A leave the
// client asked for itself (voice_leave, a channel switch, leaving a group DM) is the common
// case and the client discarded that session, so it is checked only every
// voiceOwnLeaveWatchEvery ticks; still checked, since a rejoin with the token would put the
// user in the room with no voice_states row.

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const voiceRemovedWatchInterval = 2 * time.Second

// voiceOwnLeaveWatchEvery is how many ticks apart own-leave identities are checked (10 s at the 2 s
// interval).
const voiceOwnLeaveWatchEvery = 5

const voiceRemovedWatchTimeout = 10 * time.Second

type removedIdentity struct {
	channelID int64
	userID    int64
	token     string
	until     time.Time
	// ownLeave marks a removal after the client's own leave (slower cadence); a later forced removal of the
	// same identity clears it.
	ownLeave bool
}

// removedIdentities is the identity -> removal record set; entries expire tokenTTL after the removal.
type removedIdentities struct {
	mu      syncutil.Ranked[lockRankLeaf]
	entries map[string]removedIdentity
	now     func() time.Time // test seam; nil means time.Now
}

func (s *removedIdentities) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// record remembers one removed identity for tokenTTL from now; a repeat restarts the window.
// A legacy identity with no join token names the user, not one join, so it is not recorded.
func (s *removedIdentities) record(channelID, userID int64, token string, ownLeave bool) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[string]removedIdentity{}
	}
	id := participantIdentity(userID, token)
	if prev, ok := s.entries[id]; ok && !prev.ownLeave {
		ownLeave = false
	}
	s.entries[id] = removedIdentity{channelID: channelID, userID: userID, token: token, until: s.clock().Add(tokenTTL), ownLeave: ownLeave}
}

// extend restarts the window of a remembered identity when another token is minted for it, so the window
// covers that token too.
func (s *removedIdentities) extend(identity string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[identity]
	if !ok {
		return
	}
	e.until = s.clock().Add(tokenTTL)
	s.entries[identity] = e
}

func (s *removedIdentities) pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries) > 0
}

func (s *removedIdentities) snapshot(includeOwnLeave bool) map[int64]map[string]removedIdentity {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	out := map[int64]map[string]removedIdentity{}
	for id, e := range s.entries {
		if !now.Before(e.until) {
			delete(s.entries, id)
			continue
		}
		if e.ownLeave && !includeOwnLeave {
			continue
		}
		if out[e.channelID] == nil {
			out[e.channelID] = map[string]removedIdentity{}
		}
		out[e.channelID][id] = e
	}
	return out
}

// runRemovedVoiceWatch checks remembered identities every voiceRemovedWatchInterval until
// the hub stops (started once on h.sweeps); a tick with nothing remembered does no work.
func (h *Hub) runRemovedVoiceWatch() {
	if h.livekit == nil {
		return
	}
	life := h.lifecycle.ctx
	if life == nil {
		life = context.Background()
	}
	ticker := time.NewTicker(voiceRemovedWatchInterval)
	defer ticker.Stop()
	tick := 0
	for {
		select {
		case <-h.stop:
			return
		case <-ticker.C:
			tick++
			if !h.livekit.removed.pending() {
				continue
			}
			ctx, cancel := context.WithTimeout(life, voiceRemovedWatchTimeout)
			h.enforceRemovedVoiceIdentities(ctx, tick%voiceOwnLeaveWatchEvery == 0)
			cancel()
		}
	}
}

func (h *Hub) enforceRemovedVoiceIdentities(ctx context.Context, includeOwnLeave bool) {
	for channelID, removed := range h.livekit.removed.snapshot(includeOwnLeave) {
		if ctx.Err() != nil {
			return
		}
		identities, err := h.livekit.ListParticipants(ctx, channelID)
		if err != nil {
			// Not "the room is empty": keep the entries for the next tick.
			slog.Warn("voice removed watch: ListParticipants failed, retrying next tick",
				"err", err, "channel_id", channelID)
			continue
		}
		for _, id := range identities {
			e, ok := removed[id]
			if !ok {
				continue
			}
			if h.holdsVoiceJoin(e.userID, channelID, e.token) {
				// The user's connection is in this exact join: leave it alone this tick, without forgetting
				// it.
				continue
			}
			if err := h.livekit.removeIdentity(ctx, channelID, id); err != nil {
				slog.Warn("voice removed watch: removing participant failed, retrying next tick",
					"err", err, "user_id", e.userID, "channel_id", channelID)
				continue
			}
			slog.Info("voice removed watch: removed participant",
				"user_id", e.userID, "channel_id", channelID)
		}
	}
}

// holdsVoiceJoin reports whether one of userID's connections is in the join token names.
// Every eviction clears the connection's voice state before removing the SFU identity, so a
// voice_states row that outlived its teardown does not count.
func (h *Hub) holdsVoiceJoin(userID, channelID int64, token string) bool {
	for _, c := range h.clientsOf(userID) {
		if chID, joinToken := c.voice.state(); chID == channelID && joinToken == token {
			return true
		}
	}
	return false
}
