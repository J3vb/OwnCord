package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// Phase 6 "real invisible". The property under test is a single sentence:
// an invisible user is offline to everyone but themselves, on every surface —
// the ready member list, the presence broadcast, and the connect-time
// announcement that used to stamp everyone online.

// readPresence drains ch until a presence message arrives, returning its
// payload. Returns nil if none arrives before the deadline.
func readPresence(ch <-chan []byte, deadline time.Duration) map[string]any {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case raw := <-ch:
			var env map[string]any
			if json.Unmarshal(raw, &env) != nil {
				continue
			}
			if env["type"] != "presence" {
				continue
			}
			payload, _ := env["payload"].(map[string]any)
			return payload
		case <-timer.C:
			return nil
		}
	}
}

// readyMembers pulls the members array out of a ready payload, keyed by id.
func readyMembers(t *testing.T, raw []byte) map[int64]map[string]any {
	t.Helper()
	var env struct {
		Payload struct {
			Members []map[string]any `json:"members"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	out := make(map[int64]map[string]any, len(env.Payload.Members))
	for _, m := range env.Payload.Members {
		id, _ := m["id"].(float64)
		out[int64(id)] = m
	}
	return out
}

func TestReady_InvisibleMemberIsOfflineToOthersAndTrueToSelf(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)
	ctx := context.Background()

	ghost := seedOwnerUser(t, database, "ghost")
	watcher := seedOwnerUser(t, database, "watcher")
	if err := database.UpdateUserStatus(ctx, ghost.ID, db.StatusInvisible); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, watcher.ID, db.StatusOnline); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	// Both must be connected — a member with no live session renders offline
	// regardless, which would mask the mapping this test is about.
	gc := ws.NewTestClientWithUser(hub, ghost, 0, make(chan []byte, 8))
	wc := ws.NewTestClientWithUser(hub, watcher, 0, make(chan []byte, 8))
	hub.Register(gc)
	hub.Register(wc)
	waitRegistered(t, hub, gc)
	waitRegistered(t, hub, wc)

	forWatcher, err := hub.BuildReadyForTest(database, watcher.ID)
	if err != nil {
		t.Fatalf("buildReady(watcher): %v", err)
	}
	if got := readyMembers(t, forWatcher)[ghost.ID]["status"]; got != db.StatusOffline {
		t.Errorf("ghost as seen by watcher = %v, want offline", got)
	}

	forGhost, err := hub.BuildReadyForTest(database, ghost.ID)
	if err != nil {
		t.Fatalf("buildReady(ghost): %v", err)
	}
	if got := readyMembers(t, forGhost)[ghost.ID]["status"]; got != db.StatusInvisible {
		t.Errorf("ghost as seen by themselves = %v, want invisible", got)
	}
	// The watcher's own status is unaffected in either payload.
	if got := readyMembers(t, forGhost)[watcher.ID]["status"]; got != db.StatusOnline {
		t.Errorf("watcher in ghost's ready = %v, want online", got)
	}
}

func TestReady_DisconnectedMemberWithChosenStatusRendersOffline(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)
	ctx := context.Background()

	absent := seedOwnerUser(t, database, "absent")
	viewer := seedOwnerUser(t, database, "viewer")
	// A chosen dnd survives a disconnect in the column so the next connect can
	// honour it — but it must not render as "present" in the meantime.
	if err := database.UpdateUserStatus(ctx, absent.ID, db.StatusDND); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	vc := ws.NewTestClientWithUser(hub, viewer, 0, make(chan []byte, 8))
	hub.Register(vc)
	waitRegistered(t, hub, vc)

	raw, err := hub.BuildReadyForTest(database, viewer.ID)
	if err != nil {
		t.Fatalf("buildReady: %v", err)
	}
	if got := readyMembers(t, raw)[absent.ID]["status"]; got != db.StatusOffline {
		t.Errorf("disconnected dnd member = %v, want offline", got)
	}
}

func TestBroadcastPresence_InvisibleSplitsSelfFromEveryoneElse(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	ghost := seedOwnerUser(t, database, "bc-ghost")
	other := seedOwnerUser(t, database, "bc-other")
	ghostCh := make(chan []byte, 8)
	otherCh := make(chan []byte, 8)
	gc := ws.NewTestClientWithUser(hub, ghost, 0, ghostCh)
	oc := ws.NewTestClientWithUser(hub, other, 0, otherCh)
	hub.Register(gc)
	hub.Register(oc)
	waitRegistered(t, hub, gc)
	waitRegistered(t, hub, oc)

	text := "heads down"
	hub.BroadcastPresence(ghost.ID, db.StatusInvisible, &text)

	self := readPresence(ghostCh, 500*time.Millisecond)
	if self == nil {
		t.Fatal("owner received no presence message")
	}
	if self["status"] != db.StatusInvisible {
		t.Errorf("owner sees status = %v, want invisible", self["status"])
	}
	if self["custom_status"] != text {
		t.Errorf("owner custom_status = %v, want %q", self["custom_status"], text)
	}

	seen := readPresence(otherCh, 500*time.Millisecond)
	if seen == nil {
		t.Fatal("other client received no presence message")
	}
	if seen["status"] != db.StatusOffline {
		t.Errorf("other sees status = %v, want offline", seen["status"])
	}
}

// TestBroadcastPresence_InvisibleBlanksCustomStatusForObservers pins OC-0211:
// BroadcastPresence maps an invisible user's *status* to "offline" for the
// public frame but used to pass customStatus through verbatim, so every
// other connected client received {status:"offline", custom_status:"<real
// text>"} — the surviving text is a tell that the "offline" member is
// actually online, exactly what db.MemberSummary.ForViewer deliberately
// blanks for the ready payload. This is the connect/reconnect path
// (announceConnectPresence -> BroadcastPresence), reached whenever an
// invisible user with a saved custom status connects or reconnects.
func TestBroadcastPresence_InvisibleBlanksCustomStatusForObservers(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	ghost := seedOwnerUser(t, database, "bc-ghost-cs")
	other := seedOwnerUser(t, database, "bc-other-cs")
	ghostCh := make(chan []byte, 8)
	otherCh := make(chan []byte, 8)
	gc := ws.NewTestClientWithUser(hub, ghost, 0, ghostCh)
	oc := ws.NewTestClientWithUser(hub, other, 0, otherCh)
	hub.Register(gc)
	hub.Register(oc)
	waitRegistered(t, hub, gc)
	waitRegistered(t, hub, oc)

	text := "in a meeting"
	hub.BroadcastPresence(ghost.ID, db.StatusInvisible, &text)

	self := readPresence(ghostCh, 500*time.Millisecond)
	if self == nil {
		t.Fatal("owner received no presence message")
	}
	// The owner must still see their own real custom status.
	if self["custom_status"] != text {
		t.Errorf("owner custom_status = %v, want %q", self["custom_status"], text)
	}

	seen := readPresence(otherCh, 500*time.Millisecond)
	if seen == nil {
		t.Fatal("other client received no presence message")
	}
	if seen["status"] != db.StatusOffline {
		t.Errorf("other sees status = %v, want offline", seen["status"])
	}
	// The leak: an observer must never see the real custom status text
	// alongside a collapsed-to-offline status — that combination discloses
	// that the member is actually online.
	if seen["custom_status"] != nil {
		t.Errorf("other sees custom_status = %v, want null (leaked invisible user's real status text)", seen["custom_status"])
	}
}

func TestBroadcastPresence_NonInvisibleGoesToEveryoneUnchanged(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	user := seedOwnerUser(t, database, "bc-dnd")
	ch := make(chan []byte, 8)
	c := ws.NewTestClientWithUser(hub, user, 0, ch)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.BroadcastPresence(user.ID, db.StatusDND, nil)

	got := readPresence(ch, 500*time.Millisecond)
	if got == nil {
		t.Fatal("no presence message")
	}
	if got["status"] != db.StatusDND {
		t.Errorf("status = %v, want dnd", got["status"])
	}
	if got["custom_status"] != nil {
		t.Errorf("custom_status = %v, want null", got["custom_status"])
	}
}

func TestAuthOK_CarriesOwnTrueStatusAndProfileFields(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)
	ctx := context.Background()

	user := seedOwnerUser(t, database, "authok-ghost")
	name, about, custom := "Ghosty", "boo", "lurking"
	if err := database.UpdateUserProfile(ctx, user.ID, user.Username, nil, &name, &about); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	if err := database.UpdateUserCustomStatus(ctx, user.ID, &custom); err != nil {
		t.Fatalf("UpdateUserCustomStatus: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, user.ID, db.StatusInvisible); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}
	fresh, err := database.GetUserByID(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	var env struct {
		Payload struct {
			User map[string]any `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(hub.BuildAuthOKForTest(fresh, "owner"), &env); err != nil {
		t.Fatalf("unmarshal auth_ok: %v", err)
	}
	u := env.Payload.User
	if u["status"] != db.StatusInvisible {
		t.Errorf("auth_ok status = %v, want the owner's true invisible", u["status"])
	}
	if u["display_name"] != name {
		t.Errorf("auth_ok display_name = %v, want %q", u["display_name"], name)
	}
	if u["about"] != about {
		t.Errorf("auth_ok about = %v, want %q", u["about"], about)
	}
	if u["custom_status"] != custom {
		t.Errorf("auth_ok custom_status = %v, want %q", u["custom_status"], custom)
	}
}

func TestPresenceUpdate_InvisibleIsAcceptedAndCarriesCustomStatus(t *testing.T) {
	// The coverage hub carries a real service layer, which the presence
	// handler needs — newTestHub's hub has none.
	hub, database := newCoverageHub(t)

	ghost := seedCoverageOwner(t, database, "cmd-ghost")
	other := seedCoverageOwner(t, database, "cmd-other")
	ghostCh := make(chan []byte, 16)
	otherCh := make(chan []byte, 16)
	gc := ws.NewTestClientWithUser(hub, ghost, 0, ghostCh)
	oc := ws.NewTestClientWithUser(hub, other, 0, otherCh)
	hub.Register(gc)
	hub.Register(oc)
	waitRegistered(t, hub, gc)
	waitRegistered(t, hub, oc)

	raw, _ := json.Marshal(map[string]any{
		"type": "presence_update",
		"payload": map[string]any{
			"status":        db.StatusInvisible,
			"custom_status": "shhh",
		},
	})
	hub.HandleMessageForTest(gc, raw)

	if got := readPresence(otherCh, 500*time.Millisecond); got == nil || got["status"] != db.StatusOffline {
		t.Errorf("other sees %v, want offline", got)
	}
	if got := readPresence(ghostCh, 500*time.Millisecond); got == nil || got["status"] != db.StatusInvisible {
		t.Errorf("owner sees %v, want invisible", got)
	}

	stored, err := database.GetUserByID(context.Background(), ghost.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if stored.Status != db.StatusInvisible {
		t.Errorf("stored status = %q, want invisible (uncollapsed)", stored.Status)
	}
	if stored.CustomStatus == nil || *stored.CustomStatus != "shhh" {
		t.Errorf("stored custom_status = %v, want %q", stored.CustomStatus, "shhh")
	}
}
