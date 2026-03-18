package ws

import (
	"errors"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

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
	tracks       map[int64]*VoiceTrack
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
		tracks:       make(map[int64]*VoiceTrack),
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
	r.participants = make(map[int64]*VoiceParticipant)
	r.tracks = make(map[int64]*VoiceTrack)
	r.mode = "forwarding"
}

// SetTrack stores a VoiceTrack for the given user (replaces any existing one).
func (r *VoiceRoom) SetTrack(userID int64, remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tracks[userID] = &VoiceTrack{
		UserID:  userID,
		Remote:  remote,
		Local:   local,
		Senders: make(map[int64]*webrtc.RTPSender),
	}
}

// RemoveTrack removes and returns the VoiceTrack for the given user.
// Returns nil if no track exists for that user.
func (r *VoiceRoom) RemoveTrack(userID int64) *VoiceTrack {
	r.mu.Lock()
	defer r.mu.Unlock()
	vt, ok := r.tracks[userID]
	if ok {
		delete(r.tracks, userID)
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

// TrackUserIDs returns the user IDs of all users that have an active track.
func (r *VoiceRoom) TrackUserIDs() []int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]int64, 0, len(r.tracks))
	for id := range r.tracks {
		ids = append(ids, id)
	}
	return ids
}

// GetTrack returns the VoiceTrack for the given user, or nil if not present.
func (r *VoiceRoom) GetTrack(userID int64) *VoiceTrack {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tracks[userID]
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
}
