package ws

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// deliveryClassCases is one row per concrete Event type in event.go: the class
// it must report, an instance, and the audience and queue the route has always
// delivered it on. observe is false for the two routes the minimal emit hub
// cannot reach (database-backed voice audience, the activity coalescer); their
// delivery is pinned by voice_broadcast and channel_activity tests, and here
// only their class and accessor are checked.
type deliveryClassCase struct {
	typeName string
	ev       Event
	class    deliveryClass
	observe  bool
	// want maps user id to the queue the frame must arrive on ("high",
	// "normal", "low"). A user absent from the map must receive nothing.
	want map[int64]string
}

var testEmitPayload = []byte(`{"type":"x"}`)

func deliveryClassCases() []deliveryClassCase {
	p := testEmitPayload
	return []deliveryClassCase{
		{"channelEvt", channelEvt{evType: MsgTypeChatMessage, channelID: 42, payload: p}, classChannel, true,
			map[int64]string{1: "normal", 6: "normal"}},
		{"channelActivityEvt", channelActivityEvt{channelID: 42}, classActivity, false, nil},
		{"dmEvt", dmEvt{evType: MsgTypeChatMessage, channelID: 42, participantIDs: []int64{2, 3}, payload: p}, classSequencedDM, true,
			map[int64]string{2: "normal", 3: "normal"}},
		{"TypingChannelEvent", TypingChannelEvent{channelID: 42, excludeUserID: 1, payload: p}, classExcludeSender, true,
			map[int64]string{6: "low"}},
		{"TypingDMEvent", TypingDMEvent{targetUserID: 2, payload: p}, classTypingDM, true,
			map[int64]string{2: "low"}},
		{"threadFollowEvt", threadFollowEvt{targetUserID: 2, payload: p}, classTypingDM, true,
			map[int64]string{2: "low"}},
		{"PresenceEvent", PresenceEvent{userID: 2, payload: p}, classPresence, true,
			map[int64]string{1: "normal", 2: "normal", 3: "normal", 4: "normal", 6: "normal"}},
		{"PresenceOthersEvent", PresenceOthersEvent{excludeUserID: 2, payload: p}, classPresenceOthers, true,
			map[int64]string{1: "normal", 3: "normal", 4: "normal", 6: "normal"}},
		{"PresenceSelfEvent", PresenceSelfEvent{targetUserID: 2, payload: p}, classPresenceSelf, true,
			map[int64]string{2: "normal"}},
		{"VoiceStateEvent", VoiceStateEvent{voiceChannelID: 7, userID: 4, payload: p}, classVoiceVisibility, false, nil},
		{"VoiceE2EEAnnounceEvent", VoiceE2EEAnnounceEvent{voiceChannelID: 7, excludeUserID: 5, payload: p}, classVoiceChannel, true,
			map[int64]string{4: "normal"}},
		{"VoiceE2EEOfferGuardedEvent", VoiceE2EEOfferGuardedEvent{voiceChannelID: 7, targetUserID: 4, payload: p}, classVoiceChannelGuarded, true,
			map[int64]string{4: "normal"}},
		{"DMChannelOpenEvent", DMChannelOpenEvent{targetUserID: 2, payload: p}, classUserTargeted, true,
			map[int64]string{2: "high"}},
		{"DMRequestEvent", DMRequestEvent{targetUserID: 2, payload: p}, classUserTargeted, true,
			map[int64]string{2: "high"}},
		{"CallSignalEvent", CallSignalEvent{eventType: MsgTypeCallIncoming, targetUserID: 2, payload: p}, classCallSignal, true,
			map[int64]string{2: "normal"}},
	}
}

// TestDeliveryClass_EveryEventTyped walks the package's source: every type in
// event.go with an EventType method must also have a deliveryClass method and a
// row in deliveryClassCases, and the table must not name a type that is gone.
func TestDeliveryClass_EveryEventTyped(t *testing.T) {
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	eventTypes := map[string]bool{} // has EventType, declared in event.go
	classTypes := map[string]bool{} // has deliveryClass, declared anywhere
	for _, ent := range entries {
		name := ent.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, perr := parser.ParseFile(fset, name, nil, 0)
		if perr != nil {
			t.Fatalf("parse %s: %v", name, perr)
		}
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Recv == nil || len(fd.Recv.List) != 1 {
				continue
			}
			recv := fd.Recv.List[0].Type
			if star, isStar := recv.(*ast.StarExpr); isStar {
				recv = star.X
			}
			id, ok := recv.(*ast.Ident)
			if !ok {
				continue
			}
			if fd.Name.Name == "EventType" && name == "event.go" {
				eventTypes[id.Name] = true
			}
			if fd.Name.Name == "deliveryClass" {
				classTypes[id.Name] = true
			}
		}
	}
	if len(eventTypes) == 0 {
		t.Fatal("found no EventType methods in event.go: the walk is broken")
	}
	inTable := map[string]bool{}
	for _, c := range deliveryClassCases() {
		if inTable[c.typeName] {
			t.Errorf("%s appears twice in deliveryClassCases", c.typeName)
		}
		inTable[c.typeName] = true
		if !eventTypes[c.typeName] {
			t.Errorf("deliveryClassCases names %s, which has no EventType method in event.go", c.typeName)
		}
		if got := c.ev.deliveryClass(); got != c.class {
			t.Errorf("%s.deliveryClass() = %d, want %d", c.typeName, got, c.class)
		}
		if c.class == classInvalid {
			t.Errorf("%s reports classInvalid", c.typeName)
		}
	}
	names := make([]string, 0, len(eventTypes))
	for n := range eventTypes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if !classTypes[n] {
			t.Errorf("%s has EventType but no deliveryClass method", n)
		}
		if !inTable[n] {
			t.Errorf("%s has EventType but no row in deliveryClassCases", n)
		}
	}
}

// accessorOK reports whether ev satisfies the accessor interface its class's
// emitEventsFrom case type-asserts.
func accessorOK(ev Event) bool {
	switch ev.deliveryClass() {
	case classChannel:
		_, ok := ev.(ChannelEvent)
		return ok
	case classSequencedDM:
		_, ok := ev.(SequencedDMEvent)
		return ok
	case classExcludeSender:
		_, ok := ev.(ExcludeSenderEvent)
		return ok
	case classPresenceOthers:
		_, ok := ev.(PresenceOthersEvent)
		return ok
	case classTypingDM, classUserTargeted, classCallSignal:
		_, ok := ev.(UserTargetedEvent)
		return ok
	case classPresenceSelf:
		_, ok := ev.(PresenceSelfEvent)
		return ok
	case classPresence:
		_, ok := ev.(PresenceEvent)
		return ok
	case classBroadcastAll:
		_, ok := ev.(BroadcastAllEvent)
		return ok
	case classVoiceChannel:
		_, ok := ev.(VoiceChannelEvent)
		return ok
	case classVoiceChannelGuarded:
		_, ok := ev.(VoiceChannelGuardedEvent)
		return ok
	case classVoiceVisibility:
		_, ok := ev.(VoiceVisibilityEvent)
		return ok
	case classActivity:
		_, ok := ev.(ActivityEvent)
		return ok
	case classThreadNote:
		_, ok := ev.(ThreadNoteEvent)
		return ok
	case classInvalid:
		return false
	}
	return false
}

// routeHub builds a hub with five observable clients, each with its own three
// queues so a frame's queue is visible: 1 and 6 on channel 42, 2 idle, 3 on
// channel 99, 4 in voice channel 7.
func routeHub() (*Hub, map[int64]*routeObserver) {
	h := newEmitTestHub()
	obs := map[int64]*routeObserver{}
	add := func(userID, channelID, voiceChID int64) {
		o := &routeObserver{
			high:   make(chan []byte, 8),
			normal: make(chan []byte, 8),
			low:    make(chan []byte, 8),
		}
		c := NewTestClientWithChannel(h, userID, channelID, o.normal)
		c.sendHigh = o.high
		c.sendLow = o.low
		if voiceChID > 0 {
			SetClientVoiceChID(c, voiceChID)
		}
		h.clients[userID] = []*Client{c}
		h.pubsub.Subscribe(c, TopicGlobal)
		h.pubsub.Subscribe(c, UserTopic(userID))
		if channelID > 0 {
			h.pubsub.Subscribe(c, ChannelTopic(channelID))
		}
		if voiceChID > 0 {
			h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
			h.pubsub.Subscribe(c, VoiceTopic(voiceChID))
		}
		obs[userID] = o
	}
	add(1, 42, 0)
	add(6, 42, 0)
	add(2, 0, 0)
	add(3, 99, 0)
	add(4, 0, 7)
	return h, obs
}

type routeObserver struct{ high, normal, low chan []byte }

// queue returns the queue name every frame arrived on, or "" if none, or
// "multiple" if frames split across queues. Every queue is read until the
// same deadline, so one wait after the emit covers every observer and queue.
func (o *routeObserver) queue(deadline time.Time) string {
	got := ""
	for _, q := range []struct {
		name string
		ch   chan []byte
	}{{"high", o.high}, {"normal", o.normal}, {"low", o.low}} {
		if len(drainChanUntil(q.ch, deadline)) > 0 {
			if got != "" {
				return "multiple"
			}
			got = q.name
		}
	}
	return got
}

// drainChanUntil collects frames until deadline, then whatever is already
// buffered.
func drainChanUntil(ch chan []byte, deadline time.Time) [][]byte {
	msgs := drainChan(ch, time.Until(deadline))
	for {
		select {
		case msg := <-ch:
			msgs = append(msgs, msg)
		default:
			return msgs
		}
	}
}

// TestDeliveryClass_RouteUnchanged pins, per concrete event, the queue and
// audience its route has always delivered on, so the class switch is a pure
// refactor of the old structural type switch.
func TestDeliveryClass_RouteUnchanged(t *testing.T) {
	t.Parallel()
	for _, c := range deliveryClassCases() {
		t.Run(c.typeName, func(t *testing.T) {
			if !accessorOK(c.ev) {
				t.Fatalf("%s: class %d is missing the accessor interface its route asserts", c.typeName, c.class)
			}
			if !c.observe {
				return
			}
			h, obs := routeHub()
			go h.Run()
			defer h.Stop()
			h.EmitEvents(context.Background(), []Event{c.ev})
			deadline := time.Now().Add(60 * time.Millisecond)
			for uid, o := range obs {
				if got, want := o.queue(deadline), c.want[uid]; got != want {
					t.Errorf("user %d: frame on queue %q, want %q", uid, got, want)
				}
			}
		})
	}
}

// strayEvent is an Event whose class has no route: an unset (zero) class or
// one no case handles.
type strayEvent struct{ class deliveryClass }

func (strayEvent) EventType() string              { return "test_stray" }
func (e strayEvent) deliveryClass() deliveryClass { return e.class }
func (strayEvent) Payload() []byte                { return testEmitPayload }

// mismatchEvent claims a class whose accessor interface it does not satisfy.
type mismatchEvent struct{}

func (mismatchEvent) EventType() string            { return "test_mismatch" }
func (mismatchEvent) deliveryClass() deliveryClass { return classChannel } // but no ChannelID()

// TestDeliveryClass_UnroutableDropped: an event with an unknown class, the zero
// class, or a class whose accessor assertion fails reaches nobody. Before the
// class switch, an event matching no accessor was broadcast server-wide.
func TestDeliveryClass_UnroutableDropped(t *testing.T) {
	cases := map[string]Event{
		"zero class":       strayEvent{class: classInvalid},
		"out of range":     strayEvent{class: deliveryClass(9999)},
		"assertion fails":  mismatchEvent{},
		"stubUnknownEvent": stubUnknownEvent{},
	}
	for name, ev := range cases {
		t.Run(name, func(t *testing.T) {
			var logs bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			defer slog.SetDefault(prev)

			h, obs := routeHub()
			go h.Run()
			defer h.Stop()
			h.EmitEvents(context.Background(), []Event{ev})
			deadline := time.Now().Add(60 * time.Millisecond)
			for uid, o := range obs {
				if q := o.queue(deadline); q != "" {
					t.Errorf("user %d received the unroutable event on %q; it must be dropped", uid, q)
				}
			}
			if !strings.Contains(logs.String(), "EmitEvents: unroutable event") {
				t.Errorf("drop was not logged; got %q", logs.String())
			}
		})
	}
}
