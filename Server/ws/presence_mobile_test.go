package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestParseClientFeatures_Mobile(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   []string
		want bool
	}{
		{"absent", nil, false},
		{"mobile", []string{"mobile"}, true},
		{"mobile among others", []string{"forums", "mobile"}, true},
		{"case matters", []string{"Mobile"}, false},
	}
	for _, c := range cases {
		if got := parseClientFeatures(c.in).mobile; got != c.want {
			t.Errorf("%s: mobile = %v, want %v", c.name, got, c.want)
		}
	}
	if f := parseClientFeatures([]string{"mobile"}); f.forums {
		t.Error("mobile turned on forums")
	}
}

// mobileConn is a stamped connection for the merge tests.
func mobileConn(phone bool, status string, setAt time.Time) *Client {
	c := &Client{features: clientFeatures{mobile: phone}}
	c.presence.Store(&livePresence{status: status, setAt: setAt})
	return c
}

func TestMergeLivePresence_Mobile(t *testing.T) {
	t.Parallel()
	t0 := time.Unix(1000, 0)
	later := t0.Add(time.Minute)
	cases := []struct {
		name  string
		conns []*Client
		want  bool
	}{
		{"phone only", []*Client{mobileConn(true, db.StatusOnline, t0)}, true},
		{"desktop only", []*Client{mobileConn(false, db.StatusOnline, t0)}, false},
		{"desktop and phone both online", []*Client{mobileConn(false, db.StatusOnline, t0), mobileConn(true, db.StatusOnline, later)}, false},
		{"desktop and phone both online, desktop newer", []*Client{mobileConn(true, db.StatusOnline, t0), mobileConn(false, db.StatusOnline, later)}, false},
		{"desktop idle and phone online", []*Client{mobileConn(false, db.StatusIdle, later), mobileConn(true, db.StatusOnline, t0)}, true},
		{"desktop online and phone idle", []*Client{mobileConn(false, db.StatusOnline, t0), mobileConn(true, db.StatusIdle, later)}, false},
		{"both idle", []*Client{mobileConn(false, db.StatusIdle, t0), mobileConn(true, db.StatusIdle, later)}, false},
		{"two phones", []*Client{mobileConn(true, db.StatusOnline, t0), mobileConn(true, db.StatusDND, later)}, true},
		{"unstamped desktop is ignored", []*Client{{features: clientFeatures{}}, mobileConn(true, db.StatusOnline, t0)}, true},
		{"nothing stamped", []*Client{{}}, false},
	}
	for _, c := range cases {
		if got := mergeLivePresence(c.conns).mobile; got != c.want {
			t.Errorf("%s: mobile = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSameShownPresence_ComparesMobile(t *testing.T) {
	t.Parallel()
	a := livePresence{status: db.StatusOnline}
	b := livePresence{status: db.StatusOnline, mobile: true}
	if sameShownPresence(a, b) {
		t.Fatal("presences that differ only in mobile read as the same")
	}
}

// applyPresence drives a presence_update from d the way the socket does.
func (f *mdFix) applyPresence(d *mdDev, status string) {
	f.t.Helper()
	res := Result{Events: presenceEvents(f.uid, status, nil, nil, nil, false), SetPresence: &livePresence{status: status}}
	f.hub.handleMessageApply(context.Background(), context.Background(), d.c, envelope{Type: MsgTypePresenceUpdate}, "", res, time.Now())
}

func hasMobile(p map[string]any) bool {
	v, ok := p["mobile"]
	return ok && v == true
}

func TestMultiDevice_DesktopIdleWithPhoneActiveShowsPhone(t *testing.T) {
	f := newMDFix(t)
	desktop := f.dev("session-desktop", f.text)
	phone := f.dev("session-phone", f.text)
	phone.c.features = clientFeatures{mobile: true}
	f.applyPresence(desktop, db.StatusOnline)
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil

	f.applyPresence(desktop, db.StatusIdle)
	waitFor(t, "the phone presence", func() bool { return lastPresenceFrame(obs, f.uid) != nil })
	p := lastPresenceFrame(obs, f.uid)
	if p["status"] != db.StatusOnline || !hasMobile(p) {
		t.Fatalf("presence after the desktop idled = %v, want online with mobile:true", p)
	}

	obs.got = nil
	f.applyPresence(desktop, db.StatusOnline)
	waitFor(t, "the desktop presence", func() bool { return lastPresenceFrame(obs, f.uid) != nil })
	p = lastPresenceFrame(obs, f.uid)
	if _, ok := p["mobile"]; ok || p["status"] != db.StatusOnline {
		t.Fatalf("presence after the desktop woke = %v, want online with no mobile key", p)
	}
}

func TestMultiDevice_DesktopLeavingLeavesThePhone(t *testing.T) {
	f := newMDFix(t)
	desktop := f.dev("session-desktop", f.text)
	desktop.c.setLivePresence(db.StatusOnline, nil, "")
	phone := f.dev("session-phone", f.text)
	phone.c.features = clientFeatures{mobile: true}
	phone.c.setLivePresence(db.StatusOnline, nil, "")
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil

	f.hub.unregisterNow(desktop.c)
	f.hub.rebroadcastAfterDeviceLeft(desktop.c)

	waitFor(t, "the presence after the desktop left", func() bool { return lastPresenceFrame(obs, f.uid) != nil })
	if p := lastPresenceFrame(obs, f.uid); p["status"] != db.StatusOnline || !hasMobile(p) {
		t.Fatalf("presence after the desktop left = %v, want online with mobile:true", p)
	}
}

func TestMultiDevice_InvisiblePhoneIsNeverShownToOthers(t *testing.T) {
	f := newMDFix(t)
	phone := f.dev("session-phone", f.text)
	phone.c.features = clientFeatures{mobile: true}
	obs := f.observer(f.text)
	obs.settle()
	obs.got = nil
	phone.pump()
	phone.got = nil

	f.applyPresence(phone, db.StatusInvisible)

	waitFor(t, "the owner's own frame", func() bool { return lastPresenceFrame(phone, f.uid) != nil })
	if p := lastPresenceFrame(phone, f.uid); p["status"] != db.StatusInvisible || !hasMobile(p) {
		t.Fatalf("self frame = %v, want invisible with mobile:true", p)
	}
	obs.settle()
	if p := lastPresenceFrame(obs, f.uid); p != nil && (hasMobile(p) || p["status"] != db.StatusOffline) {
		t.Fatalf("another member was sent %v for an invisible phone user", p)
	}
}

func TestPresenceEvents_InvisibleMobileOnlyInSelfFrame(t *testing.T) {
	t.Parallel()
	events := presenceEvents(5, db.StatusInvisible, nil, nil, nil, true)
	for _, ev := range events {
		pl, ok := ev.(interface{ Payload() []byte })
		if !ok {
			t.Fatalf("%T has no payload", ev)
		}
		var msg struct {
			Payload map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(pl.Payload(), &msg); err != nil {
			t.Fatalf("payload: %v", err)
		}
		_, has := msg.Payload["mobile"]
		switch ev.(type) {
		case PresenceOthersEvent:
			if has {
				t.Errorf("public frame carries mobile: %s", pl.Payload())
			}
		case PresenceSelfEvent:
			if !has {
				t.Errorf("self frame lacks mobile: %s", pl.Payload())
			}
		}
	}
}

func TestBuildPresenceBatch_MobileHiddenForInvisible(t *testing.T) {
	t.Parallel()
	h := &Hub{}
	pub, private := h.buildPresenceBatch(map[int64]pendingPresence{
		1: {status: db.StatusOnline, mobile: true},
		2: {status: db.StatusInvisible, mobile: true},
	})
	type payload struct {
		Payload presenceBatchPayload `json:"payload"`
	}
	var pubMsg, ownMsg payload
	if err := json.Unmarshal(pub, &pubMsg); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(private[2], &ownMsg); err != nil {
		t.Fatalf("no private batch for the invisible user: %v", err)
	}
	byID := func(p payload, id int64) presenceBatchEntry {
		for _, e := range p.Payload.Updates {
			if e.UserID == id {
				return e
			}
		}
		t.Fatalf("no entry for %d", id)
		return presenceBatchEntry{}
	}
	if !byID(pubMsg, 1).Mobile {
		t.Error("the online phone user's public entry lost mobile")
	}
	if e := byID(pubMsg, 2); e.Mobile || e.Status != db.StatusOffline {
		t.Errorf("invisible user's public entry = %+v, want offline without mobile", e)
	}
	if e := byID(ownMsg, 2); !e.Mobile || e.Status != db.StatusInvisible {
		t.Errorf("invisible user's own entry = %+v, want invisible with mobile", e)
	}
}

func TestPresentableMembers_Mobile(t *testing.T) {
	t.Parallel()
	phoneUser := mobileConn(true, db.StatusOnline, time.Unix(1, 0))
	phoneUser.userID = 1
	hidden := mobileConn(true, db.StatusInvisible, time.Unix(1, 0))
	hidden.userID = 2
	h := &Hub{clients: map[int64][]*Client{1: {phoneUser}, 2: {hidden}}}

	members := []db.MemberSummary{{ID: 1}, {ID: 2}, {ID: 3}}
	got := map[int64]db.MemberSummary{}
	for _, m := range h.presentableMembers(members, 9) {
		got[m.ID] = m
	}
	if !got[1].Mobile || got[1].Status != db.StatusOnline {
		t.Errorf("phone member = %+v, want online and mobile", got[1])
	}
	if got[2].Mobile || got[2].Status != db.StatusOffline {
		t.Errorf("invisible phone member seen by another = %+v, want offline without mobile", got[2])
	}
	if got[3].Mobile {
		t.Errorf("a member with no connection is mobile: %+v", got[3])
	}
	for _, m := range h.presentableMembers(members, 2) {
		if m.ID == 2 && !m.Mobile {
			t.Errorf("an invisible member lost mobile for themselves: %+v", m)
		}
	}

	dms := h.presentableDMChannels([]db.DMChannelInfo{{
		Recipient:  db.DMUser{ID: 1},
		Recipients: []db.DMUser{{ID: 1}, {ID: 2}},
	}}, 9)
	if !dms[0].Recipient.Mobile || !dms[0].Recipients[0].Mobile || dms[0].Recipients[1].Mobile {
		t.Errorf("dm recipients = %+v", dms[0])
	}
}
