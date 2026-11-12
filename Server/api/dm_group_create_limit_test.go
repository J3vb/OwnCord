package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
)

func createGroupLimitFixture(t *testing.T) (http.Handler, *auth.RateLimiter, []string) {
	t.Helper()
	database := newDMTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildLimitedDMRouter(database, &recordingBroadcaster{}, limiter)
	tokens := []string{
		dmCreateToken(t, database, "alice", 4),
		dmCreateToken(t, database, "bob", 4),
		dmCreateToken(t, database, "carol", 4),
	}
	return router, limiter, tokens
}

func postGroup(t *testing.T, router http.Handler, token string, recipients []int64) *httptest.ResponseRecorder {
	t.Helper()
	return dmPost(t, router, "/api/v1/dms/group", token, map[string]any{"recipient_ids": recipients})
}

func requireRateLimited(t *testing.T, rr *httptest.ResponseRecorder, maxRetry time.Duration) {
	t.Helper()
	requireStatus(t, rr, http.StatusTooManyRequests)
	secs, err := strconv.Atoi(rr.Header().Get("Retry-After"))
	if err != nil || secs < 1 || time.Duration(secs)*time.Second > maxRetry+time.Second {
		t.Fatalf("Retry-After = %q, want 1..%v seconds", rr.Header().Get("Retry-After"), maxRetry)
	}
}

func TestCreateGroupDM_MinuteLimitPerUser(t *testing.T) {
	router, _, tokens := createGroupLimitFixture(t)

	for range api.DMGroupCreatePerMinute {
		requireStatus(t, postGroup(t, router, tokens[0], []int64{2, 3}), http.StatusCreated)
	}
	requireRateLimited(t, postGroup(t, router, tokens[0], []int64{2, 3}), time.Minute)

	// Another user keeps their own budget.
	requireStatus(t, postGroup(t, router, tokens[1], []int64{1, 3}), http.StatusCreated)

}

func TestCreateGroupDM_BudgetSeparateFromGroupChanges(t *testing.T) {
	router, limiter, tokens := createGroupLimitFixture(t)

	group := decodeDMInfo(t, postGroup(t, router, tokens[1], []int64{1, 3}))
	path := fmt.Sprintf("/api/v1/dms/%d", group.ChannelID)

	// A spent creation budget leaves every group change available.
	for range api.DMGroupCreatePerMinute {
		requireStatus(t, postGroup(t, router, tokens[0], []int64{2, 3}), http.StatusCreated)
	}
	for i := range 20 {
		rr := dmPatch(t, router, path, tokens[0], map[string]any{"name": fmt.Sprintf("name %d", i)})
		requireStatus(t, rr, http.StatusOK)
	}

	// A spent group-change budget leaves creation available.
	requireStatus(t, dmPatch(t, router, path, tokens[1], map[string]any{"name": "bob"}), http.StatusOK)
	mutationKey := auth.Key("dm_group", 2)
	for range 20 {
		limiter.Allow(mutationKey, 20, time.Minute)
	}
	requireStatus(t, dmPatch(t, router, path, tokens[1], map[string]any{"name": "bob again"}), http.StatusTooManyRequests)
	requireStatus(t, postGroup(t, router, tokens[1], []int64{1, 3}), http.StatusCreated)
}

func TestCreateGroupDM_DailyCeilingKeepsMinuteSlot(t *testing.T) {
	router, limiter, tokens := createGroupLimitFixture(t)

	dayKey := auth.Key(api.DMGroupCreateDayKey, 1)
	for range api.DMGroupCreatePerDay - 1 {
		if !limiter.Allow(dayKey, api.DMGroupCreatePerDay, 24*time.Hour) {
			t.Fatal("prefill refused before the daily ceiling")
		}
	}
	requireStatus(t, postGroup(t, router, tokens[0], []int64{2, 3}), http.StatusCreated)
	requireRateLimited(t, postGroup(t, router, tokens[0], []int64{2, 3}), 24*time.Hour)

	// The refused call gave its minute slot back: only the one created group counts there.
	minuteKey := auth.Key(api.DMGroupCreateMinuteKey, 1)
	for i := range api.DMGroupCreatePerMinute - 1 {
		if !limiter.Allow(minuteKey, api.DMGroupCreatePerMinute, time.Minute) {
			t.Fatalf("minute slot %d already spent by the refused call", i+2)
		}
	}
	if limiter.Allow(minuteKey, api.DMGroupCreatePerMinute, time.Minute) {
		t.Fatal("minute budget larger than its limit")
	}
}

func TestCreateGroupDM_RefusedCallCreatesNothing(t *testing.T) {
	router, _, tokens := createGroupLimitFixture(t)

	for range api.DMGroupCreatePerMinute {
		requireStatus(t, postGroup(t, router, tokens[0], []int64{2, 3}), http.StatusCreated)
	}
	requireRateLimited(t, postGroup(t, router, tokens[0], []int64{2, 3}), time.Minute)

	rr := doAPIJSON(t, router, http.MethodGet, "/api/v1/dms", tokens[1], nil)
	requireStatus(t, rr, http.StatusOK)
	var list struct {
		DMChannels []json.RawMessage `json:"dm_channels"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.DMChannels) != api.DMGroupCreatePerMinute {
		t.Fatalf("bob sees %d DMs, want %d", len(list.DMChannels), api.DMGroupCreatePerMinute)
	}
}
