package ws

import (
	"log/slog"
	"strconv"
	"time"
)

const speakerBroadcastInterval = 200 * time.Millisecond

// runSpeakerBroadcast periodically checks all voice rooms for speaker changes
// and broadcasts voice_speakers to the channel. Runs until stop is closed.
func (h *Hub) runSpeakerBroadcast(stop <-chan struct{}) {
	ticker := time.NewTicker(speakerBroadcastInterval)
	defer ticker.Stop()

	// Track previous speaker lists to avoid redundant broadcasts.
	prevSpeakers := make(map[int64]string) // channelID → comma-joined speaker IDs

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			h.voiceRoomsMu.RLock()
			rooms := make(map[int64]*VoiceRoom, len(h.voiceRooms))
			for id, room := range h.voiceRooms {
				rooms[id] = room
			}
			h.voiceRoomsMu.RUnlock()

			for channelID, room := range rooms {
				speakers := room.TopSpeakers()
				mode := room.Mode()

				// Build a simple key to detect changes.
				key := speakerKey(speakers)
				if prev, ok := prevSpeakers[channelID]; ok && prev == key {
					continue // no change
				}
				prevSpeakers[channelID] = key

				msg := buildVoiceSpeakers(channelID, speakers, mode)
				slog.Debug("speaker broadcast", "channel_id", channelID, "speakers", speakers, "mode", mode)
				h.BroadcastToChannel(channelID, msg)
			}

			// Clean up stale entries for rooms that no longer exist.
			for id := range prevSpeakers {
				if _, exists := rooms[id]; !exists {
					delete(prevSpeakers, id)
				}
			}
		}
	}
}

// speakerKey builds a simple string key from speaker IDs for change detection.
// Order matters: [1,2,3] and [3,2,1] produce different keys.
func speakerKey(speakers []int64) string {
	if len(speakers) == 0 {
		return ""
	}
	// Simple concatenation — order matters for change detection.
	b := make([]byte, 0, len(speakers)*4)
	for i, id := range speakers {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, []byte(strconv.FormatInt(id, 10))...)
	}
	return string(b)
}

// SpeakerKeyForTest exposes speakerKey for use in external test packages.
// Only call from *_test.go files.
func SpeakerKeyForTest(speakers []int64) string {
	return speakerKey(speakers)
}
