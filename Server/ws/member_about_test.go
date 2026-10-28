package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/ws"
)

func setAbout(t *testing.T, database *db.DB, u *db.User, about string) {
	t.Helper()
	if err := database.UpdateUserProfile(context.Background(), u.ID, u.Username, nil, nil, &about, nil, nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
}

func TestBuildReady_MembersCarryAboutAndCreatedAt(t *testing.T) {
	hub, database := newTestHub(t)
	viewer := seedOwnerUser(t, database, "viewer")
	ghost := seedOwnerUser(t, database, "ghost")
	setAbout(t, database, ghost, "boo")
	if err := database.UpdateUserStatus(context.Background(), ghost.ID, db.StatusInvisible); err != nil {
		t.Fatal(err)
	}
	reader := &countingReader{DB: database}

	members := buildReadyMembers(t, hub, reader, viewer.ID)
	g := members[ghost.ID]
	if g == nil {
		t.Fatal("invisible member missing from ready")
	}
	if g["about"] != "boo" {
		t.Errorf("invisible member about = %v, want boo", g["about"])
	}
	if v := members[viewer.ID]; v["about"] != nil {
		t.Errorf("unset about = %v, want null", v["about"])
	}
	for id, m := range members {
		s, _ := m["created_at"].(string)
		if _, err := time.Parse(dbtime.ISOLayout, s); err != nil {
			t.Errorf("member %d created_at %q: %v", id, s, err)
		}
	}
}

func TestReadyMembersCache_AboutOnlyEditRefreshes(t *testing.T) {
	hub, database := newTestHub(t)
	viewer := seedOwnerUser(t, database, "viewer")
	reader := &countingReader{DB: database}

	if got := buildReadyMembers(t, hub, reader, viewer.ID)[viewer.ID]["about"]; got != nil {
		t.Fatalf("about before edit = %v", got)
	}
	setAbout(t, database, viewer, "fresh")
	if got := buildReadyMembers(t, hub, reader, viewer.ID)[viewer.ID]["about"]; got != "fresh" {
		t.Errorf("about after an about-only edit = %v, want fresh (stale roster cache)", got)
	}
}

func TestMemberJoin_CarriesAboutAndCreatedAt(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "join-alice")
	bob := seedMemberUser(t, database, "join-bob")
	setAbout(t, database, alice, "about alice")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, bob, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	drainChanTimeout(send, 100*time.Millisecond)

	hub.BroadcastMemberUnban(alice.ID)

	for _, m := range drainChanTimeout(send, 300*time.Millisecond) {
		if extractType(t, m) != "member_join" {
			continue
		}
		var parsed struct {
			Payload struct {
				User map[string]any `json:"user"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(m, &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Payload.User["about"] != "about alice" {
			t.Errorf("member_join about = %v", parsed.Payload.User["about"])
		}
		s, _ := parsed.Payload.User["created_at"].(string)
		if _, err := time.Parse(dbtime.ISOLayout, s); err != nil {
			t.Errorf("member_join created_at %q: %v", s, err)
		}
		return
	}
	t.Fatal("no member_join after BroadcastMemberUnban")
}
