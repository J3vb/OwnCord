package ws

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// trackKey builds a composite map key for a user's track of a given kind.
func trackKey(userID int64, kind string) string {
	return fmt.Sprintf("%d-%s", userID, kind)
}

// ErrRoomFull is returned when attempting to add a participant to a full voice room.
var ErrRoomFull = errors.New("voice room is full")

// VoiceTrack pairs an incoming remote track with its local fan-out track.
type VoiceTrack struct {
	UserID   int64
	Remote   *webrtc.TrackRemote
	Local    *webrtc.TrackLocalStaticRTP
	senderMu sync.RWMutex
	Senders  map[int64]*webrtc.RTPSender // subscriber userID -> sender
}

// AddSender records a subscriber's RTPSender (thread-safe).
func (vt *VoiceTrack) AddSender(userID int64, s *webrtc.RTPSender) {
	vt.senderMu.Lock()
	defer vt.senderMu.Unlock()
	vt.Senders[userID] = s
}

// RemoveSender removes and returns a subscriber's RTPSender.
func (vt *VoiceTrack) RemoveSender(userID int64) *webrtc.RTPSender {
	vt.senderMu.Lock()
	defer vt.senderMu.Unlock()
	s := vt.Senders[userID]
	delete(vt.Senders, userID)
	return s
}

// CopySenders returns a snapshot of the senders map for iteration.
func (vt *VoiceTrack) CopySenders() map[int64]*webrtc.RTPSender {
	vt.senderMu.RLock()
	defer vt.senderMu.RUnlock()
	cp := make(map[int64]*webrtc.RTPSender, len(vt.Senders))
	for k, v := range vt.Senders {
		cp[k] = v
	}
	return cp
}

// VoiceParticipant represents one user in a voice room.
type VoiceParticipant struct {
	UserID   int64
	JoinedAt time.Time
}

// VoiceRoomConfig holds per-room configuration derived from channel settings and server defaults.
type VoiceRoomConfig struct {
	ChannelID       int64
	MaxUsers        int    // 0 = unlimited
	Quality         string // low|medium|high
	MixingThreshold int    // forwarding → selective threshold
	TopSpeakers     int    // N for top-N selection
	MaxVideo        int    // max simultaneous video streams
}

// VoiceRoom manages voice participants for a single channel.
// It does NOT hold PeerConnections yet — those come in Phase 3/4.
type VoiceRoom struct {
	config       VoiceRoomConfig
	participants map[int64]*VoiceParticipant
	tracks       map[string]*VoiceTrack
	mode         string // "forwarding" or "selective"
	detector     *SpeakerDetector
	mu           sync.RWMutex
}

// NewVoiceRoom creates a new voice room in "forwarding" mode.
func NewVoiceRoom(cfg VoiceRoomConfig) *VoiceRoom {
	topN := cfg.TopSpeakers
	if topN <= 0 {
		topN = 3
	}
	return &VoiceRoom{
		config:       cfg,
		participants: make(map[int64]*VoiceParticipant),
		tracks:       make(map[string]*VoiceTrack),
		mode:         "forwarding",
		detector:     NewSpeakerDetector(topN),
	}
}

// AddParticipant adds a user to the voice room. Returns ErrRoomFull if
// MaxUsers > 0 and the room is already at capacity. Adding a duplicate
// user ID is a no-op.
func (r *VoiceRoom) AddParticipant(userID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Duplicate check — already present, nothing to do.
	if _, exists := r.participants[userID]; exists {
		return nil
	}

	if r.config.MaxUsers > 0 && len(r.participants) >= r.config.MaxUsers {
		return ErrRoomFull
	}

	r.participants[userID] = &VoiceParticipant{
		UserID:   userID,
		JoinedAt: time.Now(),
	}

	r.updateMode()
	return nil
}

// RemoveParticipant removes a user from the voice room. No-op if the user
// is not present.
func (r *VoiceRoom) RemoveParticipant(userID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.participants[userID]; !exists {
		return
	}

	delete(r.participants, userID)
	r.detector.RemoveSpeaker(userID)
	r.updateMode()
}

// ParticipantCount returns the number of participants (thread-safe).
func (r *VoiceRoom) ParticipantCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.participants)
}

// IsEmpty returns true if the room has no participants.
func (r *VoiceRoom) IsEmpty() bool {
	return r.ParticipantCount() == 0
}

// Mode returns the current mixing mode ("forwarding" or "selective").
func (r *VoiceRoom) Mode() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.mode
}

// ParticipantIDs returns a slice of all participant user IDs.
func (r *VoiceRoom) ParticipantIDs() []int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()

	ids := make([]int64, 0, len(r.participants))
	for id := range r.participants {
		ids = append(ids, id)
	}
	return ids
}

// HasParticipant checks whether the given user is in the room.
func (r *VoiceRoom) HasParticipant(userID int64) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, exists := r.participants[userID]
	return exists
}

// Close clears all participants and tracks from the room.
func (r *VoiceRoom) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	slog.Info("voice room closing",
		"channel_id", r.config.ChannelID,
		"participants", len(r.participants),
		"tracks", len(r.tracks))
	r.participants = make(map[int64]*VoiceParticipant)
	r.tracks = make(map[string]*VoiceTrack)
	r.mode = "forwarding"
}

// SetTrack stores a VoiceTrack for the given user and kind (replaces any existing one).
func (r *VoiceRoom) SetTrack(userID int64, kind string, remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := trackKey(userID, kind)
	_, replaced := r.tracks[key]
	r.tracks[key] = &VoiceTrack{
		UserID:  userID,
		Remote:  remote,
		Local:   local,
		Senders: make(map[int64]*webrtc.RTPSender),
	}
	codec := ""
	if remote != nil {
		codec = remote.Codec().MimeType
	}
	slog.Debug("voice room track set",
		"channel_id", r.config.ChannelID,
		"user_id", userID,
		"kind", kind,
		"replaced", replaced,
		"codec", codec,
		"total_tracks", len(r.tracks))
}

// RemoveTrack removes and returns the VoiceTrack for the given user and kind.
// Returns nil if no track exists for that user/kind.
func (r *VoiceRoom) RemoveTrack(userID int64, kind string) *VoiceTrack {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := trackKey(userID, kind)
	vt, ok := r.tracks[key]
	if ok {
		delete(r.tracks, key)
		slog.Debug("voice room track removed",
			"channel_id", r.config.ChannelID,
			"user_id", userID,
			"kind", kind,
			"remaining_tracks", len(r.tracks))
	}
	return vt
}

// GetTracks returns a snapshot of all current tracks.
func (r *VoiceRoom) GetTracks() []*VoiceTrack {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]*VoiceTrack, 0, len(r.tracks))
	for _, vt := range r.tracks {
		result = append(result, vt)
	}
	return result
}

// TrackUserIDs returns the deduplicated user IDs of all users that have an active track.
func (r *VoiceRoom) TrackUserIDs() []int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	seen := make(map[int64]struct{})
	for _, vt := range r.tracks {
		seen[vt.UserID] = struct{}{}
	}
	ids := make([]int64, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids
}

// GetTrack returns the VoiceTrack for the given user and kind, or nil if not present.
func (r *VoiceRoom) GetTrack(userID int64, kind string) *VoiceTrack {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tracks[trackKey(userID, kind)]
}

// GetUserTracks returns all tracks belonging to the given user.
func (r *VoiceRoom) GetUserTracks(userID int64) []*VoiceTrack {
	r.mu.RLock()
	defer r.mu.RUnlock()
	prefix := fmt.Sprintf("%d-", userID)
	var result []*VoiceTrack
	for key, vt := range r.tracks {
		if strings.HasPrefix(key, prefix) {
			result = append(result, vt)
		}
	}
	return result
}

// UpdateSpeakerLevel updates the audio level for a user in this room's detector.
// level is the raw RFC 6464 dBov value: 0 = loudest, 127 = silence.
func (r *VoiceRoom) UpdateSpeakerLevel(userID int64, level uint8) {
	r.detector.UpdateLevel(userID, level)
}

// TopSpeakers returns the current top-N active speakers for this room.
func (r *VoiceRoom) TopSpeakers() []int64 {
	return r.detector.TopSpeakers()
}

// Config returns a copy of the room's configuration.
func (r *VoiceRoom) Config() VoiceRoomConfig {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.config
}

// updateMode checks participant count vs threshold with ±2 hysteresis.
// Must be called with r.mu held.
func (r *VoiceRoom) updateMode() {
	count := len(r.participants)
	threshold := r.config.MixingThreshold

	if threshold <= 0 {
		return
	}

	oldMode := r.mode
	switch r.mode {
	case "forwarding":
		if count >= threshold {
			r.mode = "selective"
		}
	case "selective":
		if count <= threshold-2 {
			r.mode = "forwarding"
		}
	}
	if r.mode != oldMode {
		slog.Info("voice room mode changed",
			"channel_id", r.config.ChannelID,
			"old_mode", oldMode,
			"new_mode", r.mode,
			"participants", count,
			"threshold", threshold)
	}
}
