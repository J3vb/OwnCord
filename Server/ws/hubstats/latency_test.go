package hubstats_test

import (
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws/hubstats"
)

func TestLatency_ZeroValueRecordsAndReads(t *testing.T) {
	var l hubstats.Latency
	now := time.Now()
	past := now.Add(-5 * time.Millisecond)

	l.ObserveBroadcast(past)
	l.ObserveDispatchLag(past)
	l.ObserveChatAck(past)
	l.ObserveSeqMuHold(past)
	l.ObserveVoiceJoin(past, past, past, past, past, now)
	l.CountTopicShed()

	for name, s := range map[string]uint64{
		"broadcast":   l.BroadcastMs().Count,
		"dispatchLag": l.DispatchLagMs().Count,
		"chatAck":     l.ChatAckMs().Count,
		"voiceTotal":  l.VoiceJoinMs().Total.Count,
	} {
		if s != 1 {
			t.Errorf("%s count = %d, want 1", name, s)
		}
	}
	if l.TopicSheds() != 1 {
		t.Errorf("TopicSheds = %d, want 1", l.TopicSheds())
	}
	if l.SeqMuMaxHoldMs() <= 0 {
		t.Errorf("SeqMuMaxHoldMs = %v, want > 0", l.SeqMuMaxHoldMs())
	}
}

func TestLatency_ZeroEnqueueTimeIsSkipped(t *testing.T) {
	var l hubstats.Latency
	l.ObserveBroadcast(time.Time{})
	l.ObserveDispatchLag(time.Time{})
	if n := l.BroadcastMs().Count + l.DispatchLagMs().Count; n != 0 {
		t.Fatalf("zero enqueue times recorded %d samples, want 0", n)
	}
}

func TestLatency_CountsCoverEveryHistogram(t *testing.T) {
	var l hubstats.Latency
	hists := l.Histograms()
	counts := l.Counts()
	if len(hists) != 9 || len(counts) != len(hists) {
		t.Fatalf("got %d histograms and %d counts, want 9 each", len(hists), len(counts))
	}
	for _, nh := range hists {
		if _, ok := counts[nh.Name]; !ok {
			t.Errorf("Counts is missing %q", nh.Name)
		}
	}
	if g := l.Gauges(); len(g) != 1 || g[0].Name != "hub_seqmu_max_hold_ms" {
		t.Errorf("Gauges = %+v", g)
	}
}
