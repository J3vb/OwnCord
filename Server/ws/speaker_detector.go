package ws

import (
	"sort"
	"sync"
	"time"
)

const defaultHoldoff = 500 * time.Millisecond

// speakerLevel tracks the running audio level average for one user.
type speakerLevel struct {
	userID     int64
	levels     [10]uint8 // ring buffer, 10 samples = 200ms at 20ms frames
	pos        int
	count      int     // how many samples collected (up to 10)
	average    float64
	lastActive time.Time // last time this speaker was in top-N
}

// SpeakerDetector selects the top-N loudest speakers by RFC 6464 audio level.
type SpeakerDetector struct {
	speakers map[int64]*speakerLevel
	topN     int
	holdoff  time.Duration // how long a speaker stays in top-N after going quiet
	mu       sync.Mutex
}

// NewSpeakerDetector creates a detector with the default 500ms holdoff.
func NewSpeakerDetector(topN int) *SpeakerDetector {
	return NewSpeakerDetectorWithHoldoff(topN, defaultHoldoff)
}

// NewSpeakerDetectorWithHoldoff creates a detector with a custom holdoff duration.
func NewSpeakerDetectorWithHoldoff(topN int, holdoff time.Duration) *SpeakerDetector {
	return &SpeakerDetector{
		speakers: make(map[int64]*speakerLevel),
		topN:     topN,
		holdoff:  holdoff,
	}
}

// UpdateLevel adds an audio level sample to the ring buffer for the given user
// and recalculates the running average. Level is RFC 6464 dBov: 0 = loudest,
// 127 = silence.
func (d *SpeakerDetector) UpdateLevel(userID int64, level uint8) {
	d.mu.Lock()
	defer d.mu.Unlock()

	sl, ok := d.speakers[userID]
	if !ok {
		sl = &speakerLevel{userID: userID}
		d.speakers[userID] = sl
	}

	sl.levels[sl.pos] = level
	sl.pos = (sl.pos + 1) % len(sl.levels)
	if sl.count < len(sl.levels) {
		sl.count++
	}

	// Recalculate average over collected samples.
	var sum int
	for i := range sl.count {
		sum += int(sl.levels[i])
	}
	sl.average = float64(sum) / float64(sl.count)

	// Mark as active if not silent.
	if sl.average < 127 {
		sl.lastActive = time.Now()
	}
}

// TopSpeakers returns up to top-N user IDs sorted by lowest average level
// (loudest first). Silent speakers (average == 127) are excluded unless they
// are within the holdoff window.
func (d *SpeakerDetector) TopSpeakers() []int64 {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()

	// Collect candidates: not silent, or within holdoff.
	candidates := make([]*speakerLevel, 0, len(d.speakers))
	for _, sl := range d.speakers {
		if sl.average < 127 {
			candidates = append(candidates, sl)
		} else if !sl.lastActive.IsZero() && now.Sub(sl.lastActive) <= d.holdoff {
			candidates = append(candidates, sl)
		}
	}

	// Sort by average level ascending (loudest first).
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].average < candidates[j].average
	})

	n := d.topN
	if len(candidates) < n {
		n = len(candidates)
	}

	result := make([]int64, n)
	for i := range n {
		result[i] = candidates[i].userID
	}
	return result
}

// RemoveSpeaker removes a speaker from the detector (e.g., when they leave).
func (d *SpeakerDetector) RemoveSpeaker(userID int64) {
	d.mu.Lock()
	defer d.mu.Unlock()

	delete(d.speakers, userID)
}

// ParseAudioLevel parses an RFC 6464 one-byte header extension from raw RTP
// extension data (RFC 5285 one-byte header format). It scans for the given
// extensionID and extracts the voice activity bit and 7-bit level.
//
// Returns ok=false if the extension is not found.
func ParseAudioLevel(buf []byte, extensionID uint8) (level uint8, voice bool, ok bool) {
	if len(buf) == 0 {
		return 0, false, false
	}

	// Walk RFC 5285 one-byte header extensions.
	// Each element: 4-bit ID | 4-bit (length-1), followed by (length) data bytes.
	// ID=0 is padding, ID=15 terminates.
	i := 0
	for i < len(buf) {
		id := buf[i] >> 4
		dataLen := int(buf[i]&0x0F) + 1

		if id == 0 {
			// Padding byte — skip.
			i++
			continue
		}
		if id == 15 {
			// Terminator.
			break
		}

		i++ // move past header byte

		if i+dataLen > len(buf) {
			break
		}

		if id == extensionID && dataLen >= 1 {
			b := buf[i]
			voice = (b & 0x80) != 0
			level = b & 0x7F
			return level, voice, true
		}

		i += dataLen
	}

	return 0, false, false
}
