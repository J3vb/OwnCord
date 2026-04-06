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

// EventSink is the channel a subscribed plugin reads from. The wazero-tagged
// build forwards each event to the plugin's `on_event` exported function.
type EventSink struct {
	mu   sync.Mutex
	subs map[string][]*Instance
}

// NewEventSink returns a fresh sink. Used by the registry as the central
// fan-out for plugin event delivery.
func NewEventSink() *EventSink {
	return &EventSink{subs: make(map[string][]*Instance)}
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

// Dispatch invokes every subscriber's on_event for topic. The default build
// is a no-op; the wazero-tagged build calls into the WASM module.
func (s *EventSink) Dispatch(ctx context.Context, topic string, payload []byte) {
	s.mu.Lock()
	subs := append([]*Instance(nil), s.subs[topic]...)
	s.mu.Unlock()
	for _, inst := range subs {
		_ = inst   // wazero-tagged build calls inst.module.invoke("on_event", payload)
		_ = ctx
		_ = payload
	}
}
