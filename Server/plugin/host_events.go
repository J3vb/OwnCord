// Phase C Step 9 — `events` host capability.
//
// Plugins that subscribe to events declare topic names in their manifest.
// At activation time the wazero-tagged build wires each subscription into
// the WS pub/sub hub via Hub.Subscribe; the default build records the
// subscription in-memory only.

package plugin

import (
	"context"
	"sync"
)

// Broadcaster is a function that sends a raw JSON payload to a WS channel.
// channelID=0 broadcasts to all connected clients. It is set by the WS
// wiring code (api/router.go) so the wazero-tagged build can emit events to
// clients without importing the ws package (avoids an import cycle).
type Broadcaster func(channelID int64, payload []byte)

// EventSink is the channel a subscribed plugin reads from. The wazero-tagged
// build forwards each event to the plugin's `on_event` exported function.
type EventSink struct {
	mu          sync.Mutex
	subs        map[string][]*Instance
	broadcaster Broadcaster // set via SetBroadcaster; nil = no WS delivery
}

// NewEventSink returns a fresh sink. Used by the registry as the central
// fan-out for plugin event delivery.
func NewEventSink() *EventSink {
	return &EventSink{subs: make(map[string][]*Instance)}
}

// SetBroadcaster wires a WS-layer delivery function into the sink so that
// the wazero-tagged build can push plugin-generated events to WS clients.
// Safe to call from any goroutine; subsequent Emit calls use the new value.
func (s *EventSink) SetBroadcaster(b Broadcaster) {
	s.mu.Lock()
	s.broadcaster = b
	s.mu.Unlock()
}

// Emit delivers payload to all WS clients subscribed to channelID (or every
// client when channelID==0). It is a no-op when no broadcaster has been set.
// Called by the wazero-tagged build's host-function implementation.
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

// Subscribe binds inst to topic. Multiple plugins may subscribe to the same
// topic — events fan out to every subscriber.
func (s *EventSink) Subscribe(topic string, inst *Instance) error {
	if !inst.Manifest.HasCapability(CapEvents) {
		return ErrCapabilityNotGranted
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs[topic] = append(s.subs[topic], inst)
	return nil
}

// UnsubscribeAll removes every subscription owned by inst (called on disable).
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
// SECURITY GATE (audit 2026-04-07 finding #4 — "no rate limit on event
// delivery to plugins"). Guest delivery is NOT implemented in either build:
// the loop below touches no module, and nothing in the server calls Dispatch,
// so a plugin cannot slow the hub by handling events slowly. Wiring the
// guest call is what makes the finding real, so whoever does it must land, in
// the same change:
//
//   - a per-plugin delivery rate limit (drop, never block the caller), and
//   - the same per-call CPU-budget deadline invokeCommand applies
//     (sandbox_wazero.go), and
//   - delivery off the hub's broadcast goroutine so a slow guest cannot
//     backpressure fan-out to WS clients.
//
// Until then this stays inert on purpose.
func (s *EventSink) Dispatch(ctx context.Context, topic string, payload []byte) {
	s.mu.Lock()
	subs := append([]*Instance(nil), s.subs[topic]...)
	s.mu.Unlock()
	for _, inst := range subs {
		_ = inst // wazero-tagged build calls inst.module.invoke("on_event", payload)
		_ = ctx
		_ = payload
	}
}
