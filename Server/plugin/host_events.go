// `events` host capability: plugins subscribe to topics declared in their manifest.

package plugin

import (
	"context"
	"sync"
	"sync/atomic"
)

// Broadcaster sends a raw JSON payload to a WS channel (0 = all clients). The
// WS wiring sets it, avoiding an import cycle with ws.
type Broadcaster func(channelID int64, payload []byte)

// EventSink is the fan-out point for plugin event delivery.
type EventSink struct {
	mu          sync.Mutex
	subs        map[string][]*Instance
	broadcaster Broadcaster // set via SetBroadcaster; nil = no WS delivery
	// DispatchCount counts every Dispatch call, delivered or not.
	DispatchCount atomic.Int64
}

// NewEventSink returns an empty sink.
func NewEventSink() *EventSink {
	return &EventSink{subs: make(map[string][]*Instance)}
}

// SetBroadcaster wires the WS delivery function; safe from any goroutine.
func (s *EventSink) SetBroadcaster(b Broadcaster) {
	s.mu.Lock()
	s.broadcaster = b
	s.mu.Unlock()
}

// Emit delivers payload to subscribers of channelID (all clients when 0); a
// no-op when no broadcaster is set.
func (s *EventSink) Emit(channelID int64, payload []byte) {
	if s == nil {
		return
	}
	s.mu.Lock()
	b := s.broadcaster
	s.mu.Unlock()
	if b != nil {
		b(channelID, payload)
	}
}

// Subscribe binds inst to topic. No production caller exists yet; read the
// SECURITY GATE comment on Dispatch before adding one.
func (s *EventSink) Subscribe(topic string, inst *Instance) error {
	if !inst.Manifest.HasCapability(CapEvents) {
		return ErrCapabilityNotGranted
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs[topic] = append(s.subs[topic], inst)
	return nil
}

// UnsubscribeAll removes every subscription owned by inst.
func (s *EventSink) UnsubscribeAll(inst *Instance) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for topic, list := range s.subs {
		kept := list[:0]
		for _, e := range list {
			if e != inst {
				kept = append(kept, e)
			}
		}
		if len(kept) == 0 {
			delete(s.subs, topic)
		} else {
			s.subs[topic] = kept
		}
	}
}

// Dispatch invokes every subscriber's on_event for topic.
//
// SECURITY GATE: no rate limit exists on event delivery to plugins.
// ws/hub.go calls Dispatch on every broadcast when plugins are enabled, on the
// hub's dispatch goroutine after seqMu is released, so nothing here may block or
// re-enter the hub. No guest code runs on this path today (the loop touches no
// module and subs is empty). Wiring guest delivery must land together with a
// per-plugin rate limit (drop, never block), the CPU-budget deadline
// invokeCommand applies, and delivery off the hub's dispatch goroutine.
func (s *EventSink) Dispatch(ctx context.Context, topic string, payload []byte) {
	s.DispatchCount.Add(1)
	s.mu.Lock()
	subs := append([]*Instance(nil), s.subs[topic]...)
	s.mu.Unlock()
	for _, inst := range subs {
		_ = inst // wazero-tagged build calls inst.module.invoke("on_event", payload)
		_ = ctx
		_ = payload
	}
}
