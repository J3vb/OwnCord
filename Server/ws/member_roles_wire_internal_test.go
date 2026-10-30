package ws

// WP 6.3c: the member wire carries every held role. These are the unit-level
// pins (builders, the shared roster's byte splice) plus the resume journey.

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestBuildMemberUpdate_CarriesRoleIDs(t *testing.T) {
	var env struct {
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(buildMemberUpdate(7, "moderator", []int64{3, 4}), &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(env.Payload["role_ids"], []any{float64(3), float64(4)}) || env.Payload["role"] != "moderator" {
		t.Errorf("payload = %v, want role moderator and role_ids [3 4]", env.Payload)
	}
	// An unread holder list is omitted, never sent as an empty set that would
	// strip the member's roles client-side.
	var bare struct {
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(buildMemberUpdate(7, "moderator", nil), &bare); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := bare.Payload["role_ids"]; ok {
		t.Errorf("payload = %v, want no role_ids key when the holder list was not read", bare.Payload)
	}
}

func TestBuildMemberJoin_CarriesRoleIDs(t *testing.T) {
	raw := buildMemberJoin(&db.User{ID: 2, Username: "bob", Status: db.StatusOnline, CreatedAt: "2026-10-15 13:04:05"}, "member", []int64{3, 4})
	var env struct {
		Payload struct {
			User map[string]any `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(env.Payload.User["role_ids"], []any{float64(3), float64(4)}) {
		t.Errorf("member_join user = %v, want role_ids [3 4]", env.Payload.User)
	}
}

func TestBuildRolesUpdate_CarriesHoistMentionable(t *testing.T) {
	raw := buildRolesUpdate([]*db.Role{
		{ID: 5, Name: "Pingable", Position: 50, Hoist: true, Mentionable: true},
		{ID: 4, Name: "Member", Position: 40, IsDefault: true},
	})
	var env struct {
		Payload struct {
			Roles []map[string]any `json:"roles"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.Roles) != 2 {
		t.Fatalf("roles = %v", env.Payload.Roles)
	}
	for i, want := range [][2]bool{{true, true}, {false, false}} {
		r := env.Payload.Roles[i]
		hoist, hok := r["hoist"].(bool)
		ment, mok := r["mentionable"].(bool)
		if !hok || !mok || hoist != want[0] || ment != want[1] {
			t.Errorf("role %v: hoist/mentionable = %v/%v, want %v (both keys always present)", r["name"], r["hoist"], r["mentionable"], want)
		}
	}
}

func TestRolesUpdate_CarriesHoistMentionable(t *testing.T) {
	// The flags survive the whole path: stored, read back, framed.
	database := newTeardownTestDB(t)
	ctx := context.Background()
	role, err := database.CreateRole(ctx, "Pingable", nil, permissions.ReadMessages, 55, true, true)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	roles, err := database.ListRoles(ctx)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	var env struct {
		Payload struct {
			Roles []db.Role `json:"roles"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(buildRolesUpdate(roles), &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	i := slices.IndexFunc(env.Payload.Roles, func(r db.Role) bool { return r.ID == role.ID })
	if i < 0 || !env.Payload.Roles[i].Hoist || !env.Payload.Roles[i].Mentionable {
		t.Fatalf("roles_update = %+v, want the new role with hoist and mentionable", env.Payload.Roles)
	}
}

// The ready roster is encoded once and spliced around status and custom_status
// per viewer (serve_ready_members_cache.go). role_ids sits before custom_status,
// inside the verbatim middle, so the splice must still reassemble exactly what
// json.Marshal writes.
func TestMemberRosterSplit_WithRoleIDs(t *testing.T) {
	custom := "away \"for lunch\""
	members := []db.MemberSummary{
		{ID: 1, Username: "multi", Status: "online", MemberRoleSet: &db.MemberRoleSet{Role: "moderator", RoleIDs: []int64{3, 4}}, CustomStatus: &custom},
		{ID: 2, Username: "single", Status: "idle", MemberRoleSet: &db.MemberRoleSet{Role: "member", RoleIDs: []int64{4}}},
		{ID: 3, Username: "bannered", Status: "dnd", MemberRoleSet: &db.MemberRoleSet{Role: "member", RoleIDs: []int64{4, 9, 12}},
			MemberBanner: &db.MemberBanner{Banner: new("/api/v1/files/b"), BannerColor: new("#5865f2")}},
	}
	roster, err := encodeRoster(members)
	if err != nil {
		t.Fatalf("encodeRoster: %v", err)
	}
	for i, m := range members {
		var buf bytes.Buffer
		buf.Write(roster.enc[i].head)
		buf.WriteString(strconv.Quote(m.Status))
		buf.Write(roster.enc[i].mid)
		if roster.enc[i].custom != nil {
			buf.Write(roster.enc[i].custom)
		} else {
			buf.WriteString("null")
		}
		buf.WriteString("}")
		want, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		if !bytes.Equal(buf.Bytes(), want) {
			t.Errorf("member %d reassembled\n got %s\nwant %s", m.ID, buf.Bytes(), want)
		}
		if !bytes.Contains(roster.enc[i].mid, []byte(`"role_ids":[`)) {
			t.Errorf("member %d: role_ids is not in the cached middle: %s", m.ID, roster.enc[i].mid)
		}
	}
}

// A role added while the user is offline misses the targeted member_update. The
// visibility watermark the add moves forces the resume onto a full ready, which
// carries the new role in auth_ok.user and in the member's roster entry.
func TestResume_AfterRoleAdd_FullReadyHasRole(t *testing.T) {
	t.Parallel()
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "resume-role-user", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	ownerID, err := database.CreateUser(ctx, "resume-role-owner", "hash", int(permissions.OwnerRoleID))
	if err != nil {
		t.Fatalf("CreateUser owner: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "resume-role-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHub(t, database, limiter, svc)
	svc.Moderation.SetPermissionNotifier(hub)
	go hub.Run()
	t.Cleanup(hub.Stop)

	// Anchor a last_seq the ring buffer could replay, so the full ready is
	// provably forced by the watermark and not by a ring-buffer miss.
	rb := hub.ReplayBuffer()
	for seq := uint64(98); seq <= 100; seq++ {
		rb.Push(seq, chID, []byte(`{"seq":`+itoaTest(int64(seq))+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"x"}}`))
	}
	hub.SeedSeq(100)

	// The grant lands while the user is offline.
	if _, err := svc.Moderation.AddUserRole(ctx, ownerID, userID, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	hub.flushRoleRefresh(ctx)

	want := []any{float64(permissions.ModeratorRoleID), float64(permissions.MemberRoleID)}
	var authOK, ready bool
	for _, evt := range dialAndResume(t, hub, token, 99) {
		var frame struct {
			Type    string `json:"type"`
			Payload struct {
				User    map[string]any   `json:"user"`
				Members []map[string]any `json:"members"`
			} `json:"payload"`
		}
		if json.Unmarshal(evt, &frame) != nil {
			continue
		}
		switch frame.Type {
		case MsgTypeAuthOK:
			authOK = true
			if got := frame.Payload.User["role_ids"]; !reflect.DeepEqual(got, want) {
				t.Errorf("auth_ok.user.role_ids = %v, want %v", got, want)
			}
		case MsgTypeReady:
			ready = true
			for _, m := range frame.Payload.Members {
				if m["id"] == float64(userID) && !reflect.DeepEqual(m["role_ids"], want) {
					t.Errorf("ready member role_ids = %v, want %v", m["role_ids"], want)
				}
			}
		}
	}
	if !authOK || !ready {
		t.Fatalf("resume past a role add delivered auth_ok=%v ready=%v, want a full ready", authOK, ready)
	}
}
