package admin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// The approval queue (B4-1): list, approve, deny — each decision once.
func TestAdminAPI_Registrations_ListApproveDeny(t *testing.T) {
	ctx := context.Background()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	first, err := database.CreatePendingUser(ctx, "applicant-one", "hash", 3, 100)
	if err != nil {
		t.Fatalf("CreatePendingUser: %v", err)
	}
	second, err := database.CreatePendingUser(ctx, "applicant-two", "hash", 3, 100)
	if err != nil {
		t.Fatalf("CreatePendingUser: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/registrations", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d; body = %s", w.Code, w.Body.String())
	}
	var queue []map[string]any
	if err := json.NewDecoder(w.Body).Decode(&queue); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(queue) != 2 || queue[0]["username"] != "applicant-one" || queue[1]["username"] != "applicant-two" {
		t.Fatalf("queue = %v, want the two applications oldest first", queue)
	}

	if w := doRequest(t, handler, http.MethodPost, fmt.Sprintf("/registrations/%d/approve", first), token, nil); w.Code != http.StatusNoContent {
		t.Fatalf("approve status = %d; body = %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(ctx, first); u == nil || u.PendingApproval() {
		t.Fatalf("approved user = %+v, want pending cleared", u)
	}
	if w := doRequest(t, handler, http.MethodPost, fmt.Sprintf("/registrations/%d/deny", second), token, nil); w.Code != http.StatusNoContent {
		t.Fatalf("deny status = %d; body = %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(ctx, second); u == nil || u.RegistrationStatus != "denied" || u.Username == "applicant-two" {
		t.Fatalf("denied application = %+v, want anonymised and marked denied", u)
	}

	// Decided applications are gone from the queue; a second decision is a 404.
	if w := doRequest(t, handler, http.MethodPost, fmt.Sprintf("/registrations/%d/approve", first), token, nil); w.Code != http.StatusNotFound {
		t.Fatalf("second approve status = %d, want 404", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPost, fmt.Sprintf("/registrations/%d/deny", first), token, nil); w.Code != http.StatusNotFound {
		t.Fatalf("deny of an approved account status = %d, want 404 (never touched through the queue)", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPost, "/registrations/abc/approve", token, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("bad id status = %d, want 400", w.Code)
	}
	w = doRequest(t, handler, http.MethodGet, "/registrations", token, nil)
	queue = nil
	if err := json.NewDecoder(w.Body).Decode(&queue); err != nil || len(queue) != 0 {
		t.Fatalf("queue after decisions = %v, %v; want empty", queue, err)
	}
}

func TestAdminAPI_Registrations_RequireManageServer(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	createAdminUser(t, database)
	member := createUserWithRole(t, database, "plain-member", 3)
	pending, err := database.CreatePendingUser(context.Background(), "applicant", "hash", 3, 100)
	if err != nil {
		t.Fatalf("CreatePendingUser: %v", err)
	}

	for _, req := range []struct{ method, path string }{
		{http.MethodGet, "/registrations"},
		{http.MethodPost, fmt.Sprintf("/registrations/%d/approve", pending)},
		{http.MethodPost, fmt.Sprintf("/registrations/%d/deny", pending)},
	} {
		if w := doRequest(t, handler, req.method, req.path, member, nil); w.Code != http.StatusForbidden {
			t.Errorf("%s %s as a member: status = %d, want 403", req.method, req.path, w.Code)
		}
	}
	if u, _ := database.GetUserByID(context.Background(), pending); u == nil || !u.PendingApproval() {
		t.Fatalf("application = %+v, want untouched", u)
	}
}
