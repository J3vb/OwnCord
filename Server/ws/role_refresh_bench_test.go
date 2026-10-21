package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// BenchmarkPatchUserRole_Handler measures the admin PATCH /users/{id} role
// change against a real hub with N connected clients (WP 4.4b). The handler
// commits, invalidates and enqueues; its ns/op must not grow with the client
// count. The hub's Run loop is not started, so the figure is the request
// goroutine's own cost and the background worker does not compete for the CPU.
func BenchmarkPatchUserRole_Handler(b *testing.B) {
	for _, clients := range []int{100, 2000} {
		b.Run(fmt.Sprintf("clients=%d", clients), func(b *testing.B) {
			database := openTestDB(b)
			ctx := context.Background()
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
			hub := newTestHubDeps(b, database, nil, nil)
			for i := range 20 { // the old in-handler refresh cost scaled with channels x clients
				if _, err := database.CreateChannel(ctx, fmt.Sprintf("bench-ch-%02d", i), "text", "", "", 0); err != nil {
					b.Fatalf("CreateChannel: %v", err)
				}
			}
			for i := range clients {
				id, err := database.CreateUser(ctx, fmt.Sprintf("bench-%04d", i), "hash", 4)
				if err != nil {
					b.Fatalf("CreateUser: %v", err)
				}
				u, err := database.GetUserByID(ctx, id)
				if err != nil || u == nil {
					b.Fatalf("GetUserByID: %v", err)
				}
				hub.RegisterNowForTest(ws.NewTestClientWithUser(hub, u, 0, make(chan []byte, 256)))
			}
			adminID, err := database.CreateUser(ctx, "bench-admin", "hash", 1)
			if err != nil {
				b.Fatalf("CreateUser admin: %v", err)
			}
			token := "bench-admin-token"
			if _, err := database.CreateSession(ctx, adminID, auth.HashToken(token), "bench", "127.0.0.1"); err != nil {
				b.Fatalf("CreateSession: %v", err)
			}
			handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, perms, svcs)
			target, err := database.CreateUser(ctx, "bench-target", "hash", 4)
			if err != nil {
				b.Fatalf("CreateUser target: %v", err)
			}

			b.ResetTimer()
			for i := range b.N {
				role := 3 + i%2 // Moderator <-> Member, both below the Owner actor
				body, _ := json.Marshal(map[string]any{"role_id": role})
				req := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/users/%d", target), bytes.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, req)
				if w.Code != http.StatusOK {
					b.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
				}
			}
		})
	}
}
