package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// nsfwWatermarkOrderDo issues one request against r, mirroring
// nsfw_handler_test.go's nsfwDo (an external-package helper this internal
// test file cannot reach).
func nsfwWatermarkOrderDo(t *testing.T, r http.Handler, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	return rr
}

func nsfwWatermarkOrderPath(channelID int64) string {
	return "/api/v1/channels/" + strconv.FormatInt(channelID, 10) + "/nsfw-acknowledgement"
}

// orderRecordingNSFWBroadcaster records the order its methods are called in.
// MarkVisibilityChanged records the REAL bump (Codex round 4: a broadcaster
// without this method makes markDMVisibilityChanged's type assertion fail
// silently, so a test that only recorded from nsfwPostBumpPreNotifyHook —
// which fires unconditionally, right where the source calls
// markDMVisibilityChanged, whether or not that call actually reached
// anything — would keep passing even if the real bump call were deleted).
type orderRecordingNSFWBroadcaster struct {
	calls []string
}

func (b *orderRecordingNSFWBroadcaster) MarkVisibilityChanged() {
	b.calls = append(b.calls, "bump")
}

func (b *orderRecordingNSFWBroadcaster) SendToUser(int64, []byte) bool {
	b.calls = append(b.calls, "notify")
	return true
}

// TestNSFW_WatermarkBumpsBeforeTheNotifySend is Codex round 2, P2 / round 4,
// item A: a socket that registers between the watermark bump and the notify
// send must still land on the post-bump state — which only holds if the
// bump always completes before the notify runs, not after.
// nsfwPostBumpPreNotifyHook fires in the gap between them and marks it too,
// but "bump" itself comes from the broadcaster's real MarkVisibilityChanged
// method, not from the hook.
func TestNSFW_WatermarkBumpsBeforeTheNotifySend(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "order-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "labelled", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chID); err != nil {
		t.Fatalf("label channel: %v", err)
	}

	bc := &orderRecordingNSFWBroadcaster{}
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	MountNSFWRoutes(r, svc, bc)

	t.Cleanup(func() { nsfwPostBumpPreNotifyHook = nil })
	// The hook still marks the gap, appending to the SAME slice in real
	// time so order is observed, not reconstructed — but "bump" itself now
	// comes from the broadcaster's real MarkVisibilityChanged, above.
	nsfwPostBumpPreNotifyHook = func() { bc.calls = append(bc.calls, "gap") }

	if rr := nsfwWatermarkOrderDo(t, r, "PUT", nsfwWatermarkOrderPath(chID), token); rr.Code != 204 {
		t.Fatalf("PUT = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
	if got := bc.calls; len(got) != 3 || got[0] != "bump" || got[1] != "gap" || got[2] != "notify" {
		t.Fatalf("acknowledge order = %v, want [bump gap notify] — a socket registering between "+
			"the real bump and the notify must already observe the bumped watermark", got)
	}

	bc.calls = nil
	if rr := nsfwWatermarkOrderDo(t, r, "DELETE", nsfwWatermarkOrderPath(chID), token); rr.Code != 204 {
		t.Fatalf("DELETE = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
	if got := bc.calls; len(got) != 3 || got[0] != "bump" || got[1] != "gap" || got[2] != "notify" {
		t.Fatalf("revoke order = %v, want [bump gap notify]", got)
	}
}
