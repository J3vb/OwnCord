// Package lkstats reads a LiveKit server's Prometheus page and keeps a day of
// samples for the admin Dashboard's LiveKit card.
package lkstats

import (
	"bufio"
	"io"
	"math"
	"strconv"
	"strings"
)

// maxBody caps how much of the page is read.
const maxBody = 1 << 20

// Metrics holds the figures the card shows. A figure the page did not carry
// has its Has flag false. Labelled series are summed.
type Metrics struct {
	CPUSeconds       float64 // process_cpu_seconds_total
	RSSBytes         float64 // process_resident_memory_bytes
	Rooms            float64 // livekit_room_total
	Participants     float64 // livekit_participant_total
	TracksPublished  float64 // livekit_track_published_total
	TracksSubscribed float64 // livekit_track_subscribed_total
	BytesIn          float64 // livekit_packet_bytes{direction="incoming"}
	BytesOut         float64 // livekit_packet_bytes{direction="outgoing"}

	HasCPU, HasRSS, HasRooms, HasParticipants bool
	HasTracksPublished, HasTracksSubscribed   bool
	HasBytesIn, HasBytesOut                   bool
	livekit                                   bool
}

// LooksLikeLiveKit reports whether the page carried a process CPU counter or
// any livekit_ series; a page with neither is not LiveKit's stats page.
func (m Metrics) LooksLikeLiveKit() bool { return m.HasCPU || m.livekit }

// Parse reads Prometheus text exposition, keeping only the series the card
// needs. Comments, unknown series and malformed lines are skipped; at most
// maxBody bytes are read.
func Parse(r io.Reader) (Metrics, error) {
	var m Metrics
	sc := bufio.NewScanner(io.LimitReader(r, maxBody))
	sc.Buffer(make([]byte, 0, 64<<10), maxBody)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		name, labels, rest, ok := splitSample(line)
		if !ok {
			continue
		}
		if strings.HasPrefix(name, "livekit_") {
			m.livekit = true
		}
		if !wanted(name) {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseFloat(fields[0], 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		m.add(name, labels, v)
	}
	if err := sc.Err(); err != nil {
		return m, err
	}
	return m, nil
}

func wanted(name string) bool {
	switch name {
	case "process_cpu_seconds_total", "process_resident_memory_bytes",
		"livekit_room_total", "livekit_participant_total",
		"livekit_track_published_total", "livekit_track_subscribed_total",
		"livekit_packet_bytes":
		return true
	}
	return false
}

func (m *Metrics) add(name, labels string, v float64) {
	switch name {
	case "process_cpu_seconds_total":
		m.CPUSeconds, m.HasCPU = m.CPUSeconds+v, true
	case "process_resident_memory_bytes":
		m.RSSBytes, m.HasRSS = m.RSSBytes+v, true
	case "livekit_room_total":
		m.Rooms, m.HasRooms = m.Rooms+v, true
	case "livekit_participant_total":
		m.Participants, m.HasParticipants = m.Participants+v, true
	case "livekit_track_published_total":
		m.TracksPublished, m.HasTracksPublished = m.TracksPublished+v, true
	case "livekit_track_subscribed_total":
		m.TracksSubscribed, m.HasTracksSubscribed = m.TracksSubscribed+v, true
	case "livekit_packet_bytes":
		switch labelValue(labels, "direction") {
		case "incoming":
			m.BytesIn, m.HasBytesIn = m.BytesIn+v, true
		case "outgoing":
			m.BytesOut, m.HasBytesOut = m.BytesOut+v, true
		}
	}
}

// splitSample splits `name{labels} value [ts]` into its parts. The label block
// is scanned quote-aware, since a label value may hold a brace.
func splitSample(line string) (name, labels, rest string, ok bool) {
	i := strings.IndexAny(line, "{ \t")
	if i <= 0 {
		return "", "", "", false
	}
	name = line[:i]
	if line[i] != '{' {
		return name, "", line[i:], true
	}
	inQuote, escaped := false, false
	for j := i + 1; j < len(line); j++ {
		c := line[j]
		switch {
		case escaped:
			escaped = false
		case c == '\\' && inQuote:
			escaped = true
		case c == '"':
			inQuote = !inQuote
		case c == '}' && !inQuote:
			return name, line[i+1 : j], line[j+1:], true
		}
	}
	return "", "", "", false
}

// labelValue returns the value of one label in a label block, or "".
func labelValue(labels, key string) string {
	needle := key + `="`
	for from := 0; from < len(labels); {
		i := strings.Index(labels[from:], needle)
		if i < 0 {
			return ""
		}
		i += from
		if i == 0 || labels[i-1] == ',' || labels[i-1] == ' ' {
			rest := labels[i+len(needle):]
			if v, _, ok := strings.Cut(rest, `"`); ok {
				return v
			}
			return ""
		}
		from = i + len(needle)
	}
	return ""
}
