package lkstats

import (
	"strings"
	"testing"
)

const samplePage = `# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 12.5
process_resident_memory_bytes 1.048576e+08
go_goroutines 42
go_sched_gomaxprocs_threads 4
livekit_room_total{node_id="ND_1",node_type="SERVER"} 2
livekit_participant_total{node_id="ND_1",node_type="SERVER"} 5
livekit_track_published_total{kind="audio",node_id="ND_1"} 3
livekit_track_published_total{kind="video",node_id="ND_1"} 1
livekit_track_subscribed_total{kind="audio",node_id="ND_1"} 9
livekit_packet_bytes{direction="incoming",node_id="ND_1",node_type="SERVER",transmission="udp"} 1000
livekit_packet_bytes{direction="incoming",node_id="ND_1",node_type="SERVER",transmission="tcp"} 500
livekit_packet_bytes{direction="outgoing",node_id="ND_1",node_type="SERVER",transmission="udp"} 7e3
livekit_packet_bytes{node_id="ND_1"} 99999
livekit_packet_total{direction="incoming"} 12
`

func TestParse_SumsAndDirections(t *testing.T) {
	m, err := Parse(strings.NewReader(samplePage))
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		name      string
		got, want float64
		has       bool
	}{
		{"cpu", m.CPUSeconds, 12.5, m.HasCPU},
		{"rss", m.RSSBytes, 104857600, m.HasRSS},
		{"rooms", m.Rooms, 2, m.HasRooms},
		{"participants", m.Participants, 5, m.HasParticipants},
		{"published", m.TracksPublished, 4, m.HasTracksPublished},
		{"subscribed", m.TracksSubscribed, 9, m.HasTracksSubscribed},
		{"in", m.BytesIn, 1500, m.HasBytesIn},
		{"out", m.BytesOut, 7000, m.HasBytesOut},
		{"cores", m.Cores, 4, m.HasCores},
	}
	for _, c := range checks {
		if !c.has || c.got != c.want {
			t.Errorf("%s = %v (has %v), want %v", c.name, c.got, c.has, c.want)
		}
	}
	if !m.LooksLikeLiveKit() {
		t.Error("full page should look like LiveKit")
	}
}

func TestParse_GarbageAndOddValues(t *testing.T) {
	page := "\x00\x01 not metrics\n{broken\nlivekit_room_total{a=\"x\" 3\nlivekit_room_total NaN\nlivekit_participant_total +Inf\nlivekit_track_published_total{l=\"}\"} 4 1700000000\nprocess_cpu_seconds_total abc\n\n   \n"
	m, err := Parse(strings.NewReader(page))
	if err != nil {
		t.Fatal(err)
	}
	if m.HasRooms || m.HasParticipants || m.HasCPU {
		t.Errorf("garbage values must not count: %+v", m)
	}
	if !m.HasTracksPublished || m.TracksPublished != 4 {
		t.Errorf("brace inside a label value and a timestamp should parse: %+v", m)
	}
}

func TestParse_NotLiveKit(t *testing.T) {
	m, err := Parse(strings.NewReader("<html>hello</html>\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m.LooksLikeLiveKit() {
		t.Error("an HTML page is not LiveKit")
	}
	only, _ := Parse(strings.NewReader("livekit_something_else 1\n"))
	if !only.LooksLikeLiveKit() {
		t.Error("any livekit_ series counts as LiveKit")
	}
}

func TestParse_BodyCap(t *testing.T) {
	big := strings.Repeat("x", maxBody+10)
	if _, err := Parse(strings.NewReader("process_cpu_seconds_total 1\n" + big)); err != nil {
		t.Fatalf("an oversize body is truncated, not an error: %v", err)
	}
}
