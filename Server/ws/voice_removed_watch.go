package ws

// voice_removed_watch.go — a removed SFU identity stays removed.
//
// LiveKit access tokens cannot be revoked; they lapse after tokenTTL. So every
// identity RemoveParticipant removes is remembered for tokenTTL, and while any
// is remembered a short tick lists those rooms and removes the identity again
// if it is present. Identities carry the join token, so a fresh join (a new
// token) is never affected.

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceRemovedWatchInterval is how often remembered identities are checked.
const voiceRemovedWatchInterval = 2 * time.Second

// voiceRemovedWatchTimeout bounds one watch tick.
const voiceRemovedWatchTimeout = 10 * time.Second

type removedIdentity struct {
	channelID int64
	userID    int64
	token     string
	until     time.Time
}

// removedIdentities is the identity -> removal record set. Entries expire
// tokenTTL after the removal that recorded them.
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

// record remembers one removed identity for tokenTTL from now; a repeat
// removal restarts that window. A legacy identity with no join token names the
// user rather than one join, so it is not recorded.
func (s *removedIdentities) record(channelID, userID int64, token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[string]removedIdentity{}
	}
	s.entries[participantIdentity(userID, token)] = removedIdentity{channelID: channelID, userID: userID, token: token, until: s.clock().Add(tokenTTL)}
}

// extend restarts the window of an identity that is still remembered. Called
// when another token is minted for it, so the window covers that token too.
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

// pending reports whether any unexpired identity is remembered.
func (s *removedIdentities) pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries) > 0
}

// snapshot drops expired entries and returns the rest grouped by channel.
func (s *removedIdentities) snapshot() map[int64]map[string]removedIdentity {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	out := map[int64]map[string]removedIdentity{}
	for id, e := range s.entries {
		if !now.Before(e.until) {
			delete(s.entries, id)
			continue
		}
		if out[e.channelID] == nil {
			out[e.channelID] = map[string]removedIdentity{}
		}
		out[e.channelID][id] = e
	}
	return out
}

// runRemovedVoiceWatch checks remembered identities every
// voiceRemovedWatchInterval until the hub stops. Run starts it once on
// h.sweeps, so Done waits for it; a tick with nothing remembered does no work.
func (h *Hub) runRemovedVoiceWatch() {
	if h.livekit == nil {
		return
	}
	life := h.life
	if life == nil {
		life = context.Background()
	}
	ticker := time.NewTicker(voiceRemovedWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-ticker.C:
			if !h.livekit.removed.pending() {
				continue
			}
			// Each tick is bounded and ends early when the hub stops.
			ctx, cancel := context.WithTimeout(life, voiceRemovedWatchTimeout)
			h.enforceRemovedVoiceIdentities(ctx)
			cancel()
		}
	}
}

func (h *Hub) enforceRemovedVoiceIdentities(ctx context.Context) {
	for channelID, removed := range h.livekit.removed.snapshot() {
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
				// The user's connection is in this exact join: leave it
				// alone this tick, without forgetting it.
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

// holdsVoiceJoin reports whether one of userID's connections is in the join that
// token names. Every eviction clears the connection's voice state before it
// removes the SFU identity, so a stored voice_states row that outlived its
// teardown does not count.
func (h *Hub) holdsVoiceJoin(userID, channelID int64, token string) bool {
	for _, c := range h.clientsOf(userID) {
		if chID, joinToken := c.voice.state(); chID == channelID && joinToken == token {
			return true
		}
	}
	return false
}
