// `events` host capability.
//
// Plugins that subscribe to events declare topic names in their manifest. The
// wazero-tagged build wires each subscription into the WS pub/sub hub via
// Hub.Subscribe; the default build records it in memory only.

package plugin

import (
	"context"
	"sync"
	"sync/atomic"
)

// Broadcaster sends a raw JSON payload to a WS channel (channelID=0 broadcasts
// to all clients). The WS wiring code (api/router.go) sets it so the
// wazero-tagged build can emit events without importing ws (an import cycle).
type Broadcaster func(channelID int64, payload []byte)

// EventSink is the channel a subscribed plugin reads from. The wazero-tagged
// build forwards each event to the plugin's `on_event` exported function.
type EventSink struct {
	mu          sync.Mutex
	subs        map[string][]*Instance
	broadcaster Broadcaster // set via SetBroadcaster; nil = no WS delivery
	// DispatchCount counts every Dispatch call, delivered or not (subs is empty
	// in every build today, see Dispatch). A test uses it to assert the hub
	// withheld a call for a labelled channel's content, not only the gate's
	// verdict.
	DispatchCount atomic.Int64
}

// NewEventSink returns a fresh sink, the registry's central fan-out for plugin
// event delivery.
func NewEventSink() *EventSink {
	return &EventSink{subs: make(map[string][]*Instance)}
}

// SetBroadcaster wires a WS-layer delivery function into the sink so the
// wazero-tagged build can push plugin-generated events to WS clients. Safe from
// any goroutine; later Emit calls use the new value.
func (s *EventSink) SetBroadcaster(b Broadcaster) {
	s.mu.Lock()
	s.broadcaster = b
	s.mu.Unlock()
}

// Emit delivers payload to all WS clients subscribed to channelID (every client
// when channelID==0); a no-op when no broadcaster has been set. Called by the
// wazero-tagged build's host-function implementation.
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

// Subscribe binds inst to topic; multiple plugins may subscribe to a topic and
// events fan out to every subscriber. No production code calls it today (only
// this package's tests), so subs is empty and Dispatch's loop never iterates;
// the first caller makes it live on the hub's broadcast path, so read the
// SECURITY GATE comment on Dispatch first.
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
// SECURITY GATE: no rate limit exists on event delivery to plugins. Read this
// before adding anything to the loop below.
//
// ws/hub.go calls Dispatch on every broadcast message when an operator has
// enabled plugins (api/router.go wires h.pluginSink whenever the registry is
// non-nil), on the hub's dispatch goroutine after seqMu is released. Anything
// here is on that path and must not block or re-enter the hub.
//
// Guest delivery is not implemented in either build: the loop touches no
// module, and with no production Subscribe caller subs is empty, so no guest
// code runs on the event path and a plugin cannot slow the hub by handling
// events slowly.
//
// Wiring guest delivery makes the finding real, so the same change must land:
//
//   - a per-plugin delivery rate limit (drop, never block the caller), and
//   - the same per-call CPU-budget deadline invokeCommand applies
//     (sandbox_wazero.go), and
//   - delivery off the hub's dispatch goroutine so a slow guest cannot
//     backpressure fan-out to WS clients.
//
// Until then this stays inert on purpose.
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
