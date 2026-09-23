package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// buildOwnModerationRouter mounts GET /api/v1/users/me/moderation beside
// every route the tests below use to create ledger rows and appeals.
func buildOwnModerationRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	broadcaster := &recordingModQueueBroadcaster{}
	api.MountProfileRoutes(r, database, svc, nil, limiter, nil, nil)
	api.MountReportRoutes(r, svc, broadcaster)
	api.MountModerationQueueRoutes(r, svc, broadcaster)
	api.MountModerationRoutes(r, svc)
	api.MountAppealRoutes(r, svc)
	return r
}

func openFileTestDB(t *testing.T, path string) *db.DB {
	t.Helper()
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// postAction issues a moderator action and returns its ledger id.
func postAction(t *testing.T, h http.Handler, path, token, reqBody string) int64 {
	t.Helper()
	status, body := actJSON(t, h, http.MethodPost, path, token, reqBody)
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("action: status = %d, body = %s", status, body)
	}
	var resp struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.ID == 0 {
		t.Fatalf("action response %s: %v", body, err)
	}
	return resp.ID
}

func getOwnModeration(t *testing.T, h http.Handler, token string) []map[string]json.RawMessage {
	t.Helper()
	status, body := actJSON(t, h, http.MethodGet, "/api/v1/users/me/moderation", token, "")
	if status != http.StatusOK {
		t.Fatalf("GET own moderation: status = %d, body = %s", status, body)
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatalf("unmarshal %s: %v", body, err)
	}
	return rows
}

func field[T any](t *testing.T, row map[string]json.RawMessage, key string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(row[key], &v); err != nil {
		t.Fatalf("field %q (%s): %v", key, row[key], err)
	}
	return v
}

// TestOwnModeration is the B9 Q6 contract: the caller's own warning,
// timeout and lapsed-ban rows come back with their real ledger ids after a
// restart (read from storage, not memory), with appeal linkage and
// eligibility, never another user's rows, never a kick, and never a
// moderator-only field.
func TestOwnModeration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "owncord.db")
	database := openFileTestDB(t, path)
	h := buildOwnModerationRouter(database)
	ctx := context.Background()

	modID := mintModerator(t, database, "own-mod", 90, permissions.ModerateMembers|permissions.BanMembers)
	modToken, _ := mintSession(t, database, modID)
	victimID := mintUser(t, database, "own-victim")
	otherID := mintUser(t, database, "own-other")
	otherToken, _ := mintSession(t, database, otherID)

	// A report-linked warning, so the row carries a report_id and an actor.
	publicID := fileUserReport(t, h, otherToken, victimID)
	if status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
		`{"kind":"warning","reason":"be nice"}`); status != http.StatusNoContent {
		t.Fatalf("act(warning): status = %d, body = %s", status, body)
	}
	ledger, err := database.ListModerationActionsForTarget(ctx, victimID)
	if err != nil || len(ledger) != 1 || ledger[0].ReportID == nil {
		t.Fatalf("ledger after act = %+v, %v; want one report-linked row", ledger, err)
	}
	warnID := ledger[0].ID
	timeoutID := postAction(t, h, "/api/v1/moderation/users/"+itoa(victimID)+"/timeout", modToken,
		`{"reason":"cool off","duration_seconds":3600}`)
	otherWarnID := postAction(t, h, "/api/v1/moderation/users/"+itoa(otherID)+"/warn", modToken,
		`{"reason":"not yours"}`)
	if _, err := database.ForceLogoutWithAction(ctx, victimID, modID, nil, ""); err != nil {
		t.Fatalf("ForceLogoutWithAction: %v", err)
	}
	banID, err := database.BanUserWithAction(ctx, victimID, "spam", nil, modID, nil)
	if err != nil {
		t.Fatalf("BanUserWithAction: %v", err)
	}
	if err := database.UnbanUser(ctx, victimID); err != nil {
		t.Fatalf("UnbanUser: %v", err)
	}

	victimToken, _ := mintSession(t, database, victimID)
	if status, body := actJSON(t, h, http.MethodPost, "/api/v1/users/me/notices/"+itoa(warnID)+"/ack", victimToken, ""); status != http.StatusNoContent {
		t.Fatalf("ack: status = %d, body = %s", status, body)
	}
	status, body := actJSON(t, h, http.MethodPost, "/api/v1/appeals/", victimToken,
		`{"action_id":`+itoa(warnID)+`,"body":"it was a joke"}`)
	if status != http.StatusCreated {
		t.Fatalf("appeal: status = %d, body = %s", status, body)
	}
	var appeal struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &appeal); err != nil {
		t.Fatalf("unmarshal appeal: %v", err)
	}

	// Restart: a fresh DB handle and router over the same file.
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	database = openFileTestDB(t, path)
	t.Cleanup(func() { _ = database.Close() })
	h = buildOwnModerationRouter(database)

	rows := getOwnModeration(t, h, victimToken)
	allowed := []string{"acknowledged_at", "appeal", "appealable", "created_at", "expires_at", "id", "kind", "lifted_at", "reason"}
	gotIDs := make([]int64, 0, len(rows))
	byID := map[int64]map[string]json.RawMessage{}
	for _, row := range rows {
		keys := make([]string, 0, len(row))
		for k := range row {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if strings.Join(keys, ",") != strings.Join(allowed, ",") {
			t.Fatalf("row keys = %v, want exactly %v", keys, allowed)
		}
		id := field[int64](t, row, "id")
		gotIDs = append(gotIDs, id)
		byID[id] = row
	}
	// Newest first; the kick and the other user's warning are absent.
	if want := []int64{banID, timeoutID, warnID}; len(gotIDs) != 3 || gotIDs[0] != want[0] || gotIDs[1] != want[1] || gotIDs[2] != want[2] {
		t.Fatalf("ids = %v, want %v (other user's %d must never appear)", gotIDs, want, otherWarnID)
	}

	warn := byID[warnID]
	if field[string](t, warn, "reason") != "be nice" || field[*string](t, warn, "acknowledged_at") == nil {
		t.Fatalf("warning row = %v, want reason and acknowledged_at", warn)
	}
	if field[bool](t, warn, "appealable") {
		t.Fatal("an appealed warning must not be appealable again")
	}
	if got := field[*struct{ ID, State string }](t, warn, "appeal"); got == nil || got.ID != appeal.ID || got.State != "open" {
		t.Fatalf("warning appeal = %+v, want {%s open}", got, appeal.ID)
	}

	timeout := byID[timeoutID]
	if field[*string](t, timeout, "expires_at") == nil || !field[bool](t, timeout, "appealable") ||
		string(timeout["appeal"]) != "null" {
		t.Fatalf("timeout row = %v, want expires_at, appealable, appeal null", timeout)
	}
	if ban := byID[banID]; field[string](t, ban, "kind") != "ban" || !field[bool](t, ban, "appealable") {
		t.Fatalf("lapsed ban row = %v, want an appealable ban", ban)
	}

	otherRows := getOwnModeration(t, h, otherToken)
	if len(otherRows) != 1 || field[int64](t, otherRows[0], "id") != otherWarnID {
		t.Fatalf("other user's rows = %v, want only warning %d", otherRows, otherWarnID)
	}
}

// TestOwnModeration_RateLimited: the read is budgeted per IP like its
// /users/me siblings.
func TestOwnModeration_RateLimited(t *testing.T) {
	database := newModQueueActTestDB(t)
	h := buildOwnModerationRouter(database)
	token, _ := mintSession(t, database, mintUser(t, database, "own-rl"))
	for i := range 30 {
		if status, body := actJSON(t, h, http.MethodGet, "/api/v1/users/me/moderation", token, ""); status != http.StatusOK {
			t.Fatalf("request %d: status = %d, body = %s", i+1, status, body)
		}
	}
	if status, _ := actJSON(t, h, http.MethodGet, "/api/v1/users/me/moderation", token, ""); status != http.StatusTooManyRequests {
		t.Fatalf("request 31: status = %d, want 429", status)
	}
}
