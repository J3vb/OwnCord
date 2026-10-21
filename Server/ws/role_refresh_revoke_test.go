package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// rvDrain reads frames from ch until it has been quiet for d.
func rvDrain(ch <-chan []byte, d time.Duration) [][]byte {
	var out [][]byte
	for {
		select {
		case m := <-ch:
			out = append(out, m)
		case <-time.After(d):
			return out
		}
	}
}

func hasFrame(frames [][]byte, marker string) bool {
	for _, f := range frames {
		if strings.Contains(string(f), marker) {
			return true
		}
	}
	return false
}

// A single-user role change releases the user's held channels before the
// request answers, even while the worker is mid-round for other users: chat
// frames for the channel they lost never reach their queue, before or after
// the round is released. The named member also receives the member_update.
func TestRoleRefresh_NamedUserRevokedWhileRoundHeld(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = 0 WHERE id = 4`); err != nil {
		t.Fatalf("strip member role: %v", err)
	}
	chX := seedTestChannel(t, database, "revoke-chan")
	hub := newTestHubDeps(t, database, nil, nil)
	go hub.Run()
	t.Cleanup(func() {
		hub.Stop()
		<-hub.Done()
	})

	connect := func(name string, role int, ch int64) (int64, chan []byte) {
		id, err := database.CreateUser(ctx, name, "hash", role)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		u, err := database.GetUserByID(ctx, id)
		if err != nil || u == nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		send := make(chan []byte, 256)
		c := ws.NewTestClientWithUser(hub, u, ch, send)
		hub.RegisterNowForTest(c)
		if ch > 0 {
			hub.PubSubForTest().Subscribe(c, ws.ChannelTopic(ch))
		}
		return id, send
	}
	demoted, demotedSend := connect("rv-demoted", 3, chX)
	other, otherSend := connect("rv-other", 4, 0)

	var once sync.Once
	entered, release := make(chan struct{}), make(chan struct{})
	hub.SetRoleRefreshGateForTest(func() {
		once.Do(func() {
			close(entered)
			<-release
		})
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	hub.EnqueueRoleRefresh(ws.RoleRefresh{Visibility: []int64{other}})
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the round never started")
	}

	chat := func(marker string) []byte {
		return []byte(`{"type":"chat_message","payload":{"channel_id":` + strconv.FormatInt(chX, 10) + `,"content":"` + marker + `"}}`)
	}
	hub.BroadcastToChannel(chX, chat("control-before"))
	if !hasFrame(rvDrain(demotedSend, 400*time.Millisecond), "control-before") {
		t.Fatal("setup: the member does not receive channel frames before the role change")
	}

	checker := permissions.NewChecker(database)
	perms := service.NewPermissionService(database, checker)
	svcs := &service.Services{
		Moderation: service.NewModerationService(database, perms),
		Roles:      service.NewRoleService(database, perms),
		Settings:   service.NewSettingsService(database),
		Channels:   service.NewChannelService(database, service.NewPermissionService(database, nil)),
		Users:      service.NewUserService(database),
		Tokens:     service.NewTokenService(database),
		Sessions:   service.NewSessionService(database),
		Auth:       service.NewAuthService(database, auth.NewRateLimiter(), nil, nil),
	}
	adminID, err := database.CreateUser(ctx, "rv-admin", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser admin: %v", err)
	}
	if _, err := database.CreateSession(ctx, adminID, auth.HashToken("rv-token"), "t", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, perms, svcs)
	body, _ := json.Marshal(map[string]any{"role_id": 4})
	req := httptest.NewRequest(http.MethodPatch, "/users/"+strconv.FormatInt(demoted, 10), bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer rv-token")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}

	hub.BroadcastToChannel(chX, chat("after-demotion"))
	if hasFrame(rvDrain(demotedSend, 400*time.Millisecond), "after-demotion") {
		t.Error("a channel frame reached the demoted member while the round was held")
	}
	close(release)
	hub.BroadcastToChannel(chX, chat("after-release"))
	deadline := time.Now().Add(10 * time.Second)
	sawUpdate := false
	for time.Now().Before(deadline) && !sawUpdate {
		sawUpdate = hasFrame(rvDrain(otherSend, 100*time.Millisecond), `"member_update"`)
	}
	if !sawUpdate {
		t.Error("no member_update reached a connected member after the round was released")
	}
	if hasFrame(rvDrain(demotedSend, 300*time.Millisecond), "after-release") {
		t.Error("a channel frame reached the demoted member after the round was released")
	}
}
