package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The /api/v1/blocks routes are mounted by MountDMRoutes but were never
// exercised: handleListBlocks, handleBlockUser and handleUnblockUser had no
// test hitting them, so the whole blocking feature was untested from the REST
// edge down to the database. These tests reuse the DM harness
// (newDMTestDB / buildDMRouter / dmCreateToken) since the routes share a mount.

// dmPut issues a PUT against the DM/blocks router. The existing helpers cover
// POST, GET and DELETE only.
func dmPut(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// decodeBlockedIDs pulls blocked_user_ids out of a GET /api/v1/blocks response.
func decodeBlockedIDs(t *testing.T, rr *httptest.ResponseRecorder) []int64 {
	t.Helper()
	var body struct {
		BlockedUserIDs []int64 `json:"blocked_user_ids"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode blocked_user_ids from %q: %v", rr.Body.String(), err)
	}
	return body.BlockedUserIDs
}

// ─── PUT /api/v1/blocks/{userId} (handleBlockUser) ──────────────────────────

func TestBlockUser_Success(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)
	dmCreateToken(t, database, "bob", 4) // user id 2

	rr := dmPut(t, router, "/api/v1/blocks/2", alice)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}

	blocked, err := database.IsBlocked(t.Context(), 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked: %v", err)
	}
	if !blocked {
		t.Error("block was not persisted")
	}
}

func TestBlockUser_SelfBlockRejected(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)

	rr := dmPut(t, router, "/api/v1/blocks/1", alice)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d for a self-block, want 400 (body %q)", rr.Code, rr.Body.String())
	}
}

func TestBlockUser_UnknownTarget(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)

	rr := dmPut(t, router, "/api/v1/blocks/9999", alice)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d for an unknown target, want 404 (body %q)", rr.Code, rr.Body.String())
	}
}

func TestBlockUser_InvalidUserID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)

	rr := dmPut(t, router, "/api/v1/blocks/not-a-number", alice)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d for a non-numeric userId, want 400 (body %q)", rr.Code, rr.Body.String())
	}
}

func TestBlockUser_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	dmCreateToken(t, database, "bob", 4)

	rr := dmPut(t, router, "/api/v1/blocks/1", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d without a token, want 401 (body %q)", rr.Code, rr.Body.String())
	}
}

// ─── DELETE /api/v1/blocks/{userId} (handleUnblockUser) ─────────────────────

func TestUnblockUser_Success(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)
	dmCreateToken(t, database, "bob", 4)

	if rr := dmPut(t, router, "/api/v1/blocks/2", alice); rr.Code != http.StatusOK {
		t.Fatalf("setup block failed: status %d", rr.Code)
	}

	rr := dmDelete(t, router, "/api/v1/blocks/2", alice)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}

	blocked, err := database.IsBlocked(t.Context(), 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked: %v", err)
	}
	if blocked {
		t.Error("block survived the unblock request")
	}
}

func TestUnblockUser_NotBlockedStillSucceeds(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)
	dmCreateToken(t, database, "bob", 4)

	// Unblocking someone who was never blocked is a no-op, not a 404.
	rr := dmDelete(t, router, "/api/v1/blocks/2", alice)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
}

func TestUnblockUser_InvalidUserID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)

	rr := dmDelete(t, router, "/api/v1/blocks/abc", alice)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d for a non-numeric userId, want 400 (body %q)", rr.Code, rr.Body.String())
	}
}

func TestUnblockUser_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})

	rr := dmDelete(t, router, "/api/v1/blocks/2", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d without a token, want 401 (body %q)", rr.Code, rr.Body.String())
	}
}

// ─── GET /api/v1/blocks (handleListBlocks) ──────────────────────────────────

func TestListBlocks_EmptyArray(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)

	rr := dmGet(t, router, "/api/v1/blocks", alice)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}

	// The service normalizes nil to an empty slice specifically so this
	// serializes as [] rather than null.
	if got := rr.Body.String(); !jsonContainsEmptyBlockList(got) {
		t.Errorf("body = %q, want blocked_user_ids to be []", got)
	}
	if ids := decodeBlockedIDs(t, rr); len(ids) != 0 {
		t.Errorf("blocked_user_ids = %v, want empty", ids)
	}
}

func TestListBlocks_ReturnsBlockedIDs(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	alice := dmCreateToken(t, database, "alice", 4)
	bob := dmCreateToken(t, database, "bob", 4)
	dmCreateToken(t, database, "carol", 4) // user id 3

	for _, target := range []string{"2", "3"} {
		if rr := dmPut(t, router, "/api/v1/blocks/"+target, alice); rr.Code != http.StatusOK {
			t.Fatalf("setup block of %s failed: status %d", target, rr.Code)
		}
	}

	rr := dmGet(t, router, "/api/v1/blocks", alice)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	ids := decodeBlockedIDs(t, rr)
	if len(ids) != 2 {
		t.Fatalf("blocked_user_ids = %v, want 2 entries", ids)
	}

	// Blocks are per-user: bob sees none of alice's.
	rr = dmGet(t, router, "/api/v1/blocks", bob)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d for bob, want 200", rr.Code)
	}
	if ids := decodeBlockedIDs(t, rr); len(ids) != 0 {
		t.Errorf("bob's blocked_user_ids = %v, want empty", ids)
	}
}

func TestListBlocks_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})

	rr := dmGet(t, router, "/api/v1/blocks", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d without a token, want 401", rr.Code)
	}
}

// jsonContainsEmptyBlockList reports whether the payload encodes an empty JSON
// array (not null) for blocked_user_ids.
func jsonContainsEmptyBlockList(body string) bool {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return false
	}
	return string(raw["blocked_user_ids"]) == "[]"
}
