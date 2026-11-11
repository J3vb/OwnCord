// Package hubstats holds the hub's in-process metrics: the latency histograms behind
// /api/v1/metrics and the process-lifetime counters. Zero values are usable. Unlike the
// OpenTelemetry instruments (only under -tags otel), these exist in every build. All
// access is atomic; nothing here takes a lock.
package hubstats

import (
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
)

// Latency is the shipped latency surface. It must not be copied.
type Latency struct {
	broadcast metrics.Histogram
	// dispatchLag is enqueue to dispatch-start: how long a frame waited for the single dispatch goroutine.
	dispatchLag metrics.Histogram
	// chatAck is chat_send receipt to its chat_send_ok being queued, compared against k6's client-side
	// figure.
	chatAck   metrics.Histogram
	seqMuHold metrics.MaxGauge
	// topicSheds counts channel frames the topic limiter dropped before a seq was assigned.
	topicSheds atomic.Uint64
	voiceJoin  voiceJoin
}

// voiceJoin times the phases of a voice join that reaches the joiner; a refused or rolled-back join records
// nothing.
type voiceJoin struct {
	precheck, leave, persist, token, complete, total metrics.Histogram
}

// VoiceJoinPhases is the voice_join_ms snapshot: precheck, leave, persist, token, complete and total.
type VoiceJoinPhases struct {
	Precheck metrics.Summary `json:"precheck"`
	Leave    metrics.Summary `json:"leave"`
	Persist  metrics.Summary `json:"persist"`
	Token    metrics.Summary `json:"token"`
	Complete metrics.Summary `json:"complete"`
	Total    metrics.Summary `json:"total"`
}

// LatencyCounts holds the raw cumulative counts of every latency histogram keyed by its JSON name, as
// Histograms names them.
type LatencyCounts map[string]metrics.Counts

func sinceMs(t time.Time) float64 { return float64(time.Since(t)) / float64(time.Millisecond) }

// ObserveSeqMuHold records how long the current seqMu critical section has been held, from start (taken after
// Lock returned).
func (l *Latency) ObserveSeqMuHold(start time.Time) { l.seqMuHold.Observe(sinceMs(start)) }

// ObserveDispatchLag records enqueue to dispatch-start in ms; a zero enqueuedAt is skipped.
func (l *Latency) ObserveDispatchLag(enqueuedAt time.Time) {
	if enqueuedAt.IsZero() {
		return
	}
	l.dispatchLag.Observe(sinceMs(enqueuedAt))
}

// ObserveBroadcast records enqueue to fanout-done in ms; a zero enqueuedAt is skipped.
func (l *Latency) ObserveBroadcast(enqueuedAt time.Time) {
	if enqueuedAt.IsZero() {
		return
	}
	l.broadcast.Observe(sinceMs(enqueuedAt))
}

// ObserveChatAck records chat_send receipt to its chat_send_ok being queued.
func (l *Latency) ObserveChatAck(receivedAt time.Time) { l.chatAck.Observe(sinceMs(receivedAt)) }

// ObserveVoiceJoin records one completed join from the timestamps taken as each phase ended.
func (l *Latency) ObserveVoiceJoin(start, precheckDone, leaveDone, persistDone, tokenDone, completeDone time.Time) {
	ms := func(from, to time.Time) float64 { return float64(to.Sub(from)) / float64(time.Millisecond) }
	v := &l.voiceJoin
	v.precheck.Observe(ms(start, precheckDone))
	v.leave.Observe(ms(precheckDone, leaveDone))
	v.persist.Observe(ms(leaveDone, persistDone))
	v.token.Observe(ms(persistDone, tokenDone))
	v.complete.Observe(ms(tokenDone, completeDone))
	v.total.Observe(ms(start, completeDone))
}

// CountTopicShed counts one channel frame the topic limiter dropped.
func (l *Latency) CountTopicShed() { l.topicSheds.Add(1) }

// TopicSheds is the cumulative count of frames the topic limiter dropped.
func (l *Latency) TopicSheds() uint64 { return l.topicSheds.Load() }

// SeqMuMaxHoldMs is the longest single seqMu hold observed since start.
func (l *Latency) SeqMuMaxHoldMs() float64 { return l.seqMuHold.Millis() }

// BroadcastMs returns the current enqueue-to-fanout-done latency distribution.
func (l *Latency) BroadcastMs() metrics.Summary { return l.broadcast.Snapshot() }

// DispatchLagMs returns the current enqueue-to-dispatch lag distribution.
func (l *Latency) DispatchLagMs() metrics.Summary { return l.dispatchLag.Snapshot() }

// ChatAckMs returns the current chat send-to-ack latency distribution.
func (l *Latency) ChatAckMs() metrics.Summary { return l.chatAck.Snapshot() }

// VoiceJoinMs returns the per-phase voice join distributions.
func (l *Latency) VoiceJoinMs() VoiceJoinPhases {
	v := &l.voiceJoin
	return VoiceJoinPhases{
		Precheck: v.precheck.Snapshot(),
		Leave:    v.leave.Snapshot(),
		Persist:  v.persist.Snapshot(),
		Token:    v.token.Snapshot(),
		Complete: v.complete.Snapshot(),
		Total:    v.total.Snapshot(),
	}
}

// Histograms lists every latency histogram under its JSON name; the slice is fresh and points at l's own
// histograms.
func (l *Latency) Histograms() []metrics.NamedHistogram {
	v := &l.voiceJoin
	return []metrics.NamedHistogram{
		{Name: "ws_broadcast_ms", H: &l.broadcast},
		{Name: "ws_dispatch_lag_ms", H: &l.dispatchLag},
		{Name: "chat_send_ack_ms", H: &l.chatAck},
		{Name: "voice_join_ms.precheck", H: &v.precheck},
		{Name: "voice_join_ms.leave", H: &v.leave},
		{Name: "voice_join_ms.persist", H: &v.persist},
		{Name: "voice_join_ms.token", H: &v.token},
		{Name: "voice_join_ms.complete", H: &v.complete},
		{Name: "voice_join_ms.total", H: &v.total},
	}
}

// Gauges lists every max gauge under its JSON name.
func (l *Latency) Gauges() []metrics.NamedMaxGauge {
	return []metrics.NamedMaxGauge{{Name: "hub_seqmu_max_hold_ms", G: &l.seqMuHold}}
}

// Counts reads every histogram's raw counts with atomic loads only.
func (l *Latency) Counts() LatencyCounts {
	hists := l.Histograms()
	out := make(LatencyCounts, len(hists))
	for _, nh := range hists {
		out[nh.Name] = nh.H.Counts()
	}
	return out
}
