package ws

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// lastPresenceFrame is the payload of the newest presence frame the observer
// has been sent for uid, nil when there is none.
func lastPresenceFrame(d *mdDev, uid int64) map[string]any {
	d.pump()
	var last map[string]any
	for _, fr := range d.got {
		if frameType(fr) != "presence" {
			continue
		}
		if p := framePayload(fr); int64Of(p["user_id"]) == uid {
			last = p
		}
	}
	return last
}

// Closing the device that reported the game and song, while an idle device
// stays, re-sends the user's presence: idle, no game, no song (vault #148).
func TestMultiDevice_ClosingTheActiveDeviceRebroadcastsPresence(t *testing.T) {
	f := newMDFix(t)
	f.hub.gameActivity.on.Store(true)
	a := f.dev("session-a", f.text)
	a.c.setLivePresence(db.StatusOnline, nil, "")
	f.hub.applyActivity(a.c, &gameActivity{Name: "Chess", StartedAt: 1})
	f.hub.applyListening(a.c, &listeningActivity{Title: "T", Artist: "A", Player: "P", StartedAt: 2})
	b := f.dev("session-b", f.text)
	b.c.setLivePresence(db.StatusIdle, nil, "")
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil

	f.hub.unregisterNow(a.c)
	f.hub.rebroadcastAfterDeviceLeft(a.c)

	waitFor(t, "the presence after A left", func() bool { return lastPresenceFrame(obs, f.uid) != nil })
	p := lastPresenceFrame(obs, f.uid)
	if p["status"] != db.StatusIdle || p["activity"] != nil || p["listening"] != nil {
		t.Fatalf("presence after A left = %v, want idle with no game or song", p)
	}
}

// A device whose leaving changes nothing the others see sends no frame.
func TestMultiDevice_ClosingAnUnseenDeviceSendsNothing(t *testing.T) {
	t.Parallel()
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	a.c.setLivePresence(db.StatusIdle, nil, "")
	b := f.dev("session-b", f.text)
	b.c.setLivePresence(db.StatusOnline, nil, "")
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil

	f.hub.unregisterNow(a.c)
	f.hub.rebroadcastAfterDeviceLeft(a.c)

	obs.settle()
	if p := lastPresenceFrame(obs, f.uid); p != nil {
		t.Fatalf("an idle device's leaving sent a presence frame: %v", p)
	}
}

// An invisible user's remaining devices hear the change; other members get
// nothing, since a frame would show them the user is online.
func TestMultiDevice_ClosingADeviceWhileInvisibleTellsOnlyTheUser(t *testing.T) {
	t.Parallel()
	f := newMDFix(t)
	f.hub.gameActivity.on.Store(true)
	a := f.dev("session-a", f.text)
	a.c.setLivePresence(db.StatusInvisible, nil, "")
	f.hub.applyActivity(a.c, &gameActivity{Name: "Chess", StartedAt: 1})
	b := f.dev("session-b", f.text)
	b.c.setLivePresence(db.StatusInvisible, nil, "")
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil
	b.pump()
	b.got = nil

	f.hub.unregisterNow(a.c)
	f.hub.rebroadcastAfterDeviceLeft(a.c)

	waitFor(t, "B to hear the game end", func() bool { return lastPresenceFrame(b, f.uid) != nil })
	if p := lastPresenceFrame(b, f.uid); p["status"] != db.StatusInvisible || p["activity"] != nil {
		t.Fatalf("B's presence = %v, want invisible with no game", p)
	}
	obs.settle()
	if p := lastPresenceFrame(obs, f.uid); p != nil {
		t.Fatalf("another member heard an invisible user's device leave: %v", p)
	}
}

// A device kicked off (its session revoked, a sweep) leaves the registry
// before its read loop ends; its teardown still re-sends the presence.
func TestMultiDevice_KickingTheActiveDeviceRebroadcastsPresence(t *testing.T) {
	f := newMDFix(t)
	f.hub.gameActivity.on.Store(true)
	a := f.dev("session-a", f.text)
	a.c.setLivePresence(db.StatusOnline, nil, "")
	f.hub.applyActivity(a.c, &gameActivity{Name: "Chess", StartedAt: 1})
	b := f.dev("session-b", f.text)
	b.c.setLivePresence(db.StatusIdle, nil, "")
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil

	f.hub.kickClientTerminal(a.c)
	if replaced := f.hub.unregisterNow(a.c); replaced {
		t.Fatal("a kicked device reads as replaced")
	}
	f.hub.rebroadcastAfterDeviceLeft(a.c)

	waitFor(t, "the presence after A was kicked", func() bool { return lastPresenceFrame(obs, f.uid) != nil })
	if p := lastPresenceFrame(obs, f.uid); p["status"] != db.StatusIdle || p["activity"] != nil {
		t.Fatalf("presence after A was kicked = %v, want idle with no game", p)
	}
}
