package admin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// TestAdminAPI_Registrations_PagesPastFifty: with more applicants than one
// page, the limit+1 over-fetch the Members > Pending view sends reaches every
// one of them, oldest first, with no gap or repeat between pages.
func TestAdminAPI_Registrations_PagesPastFifty(t *testing.T) {
	ctx := context.Background()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	const total = 57
	for i := range total {
		if _, err := database.CreatePendingUser(ctx, fmt.Sprintf("applicant-%02d", i), "hash", 3, 100); err != nil {
			t.Fatalf("CreatePendingUser: %v", err)
		}
	}

	page := func(offset int) []string {
		t.Helper()
		w := doRequest(t, handler, http.MethodGet, fmt.Sprintf("/registrations?limit=51&offset=%d", offset), token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("offset %d: status = %d; body = %s", offset, w.Code, w.Body.String())
		}
		var rows []struct {
			Username string `json:"username"`
		}
		if err := json.NewDecoder(w.Body).Decode(&rows); err != nil {
			t.Fatalf("decode: %v", err)
		}
		names := make([]string, len(rows))
		for i, r := range rows {
			names[i] = r.Username
		}
		return names
	}

	first := page(0)
	if len(first) != 51 {
		t.Fatalf("first page = %d rows, want 51 (a full page plus the overflow row)", len(first))
	}
	second := page(50)
	if len(second) != total-50 {
		t.Fatalf("second page = %d rows, want %d", len(second), total-50)
	}
	seen := make([]string, 0, total)
	seen = append(seen, first[:50]...)
	seen = append(seen, second...)
	for i, name := range seen {
		if want := fmt.Sprintf("applicant-%02d", i); name != want {
			t.Fatalf("row %d = %q, want %q", i, name, want)
		}
	}

	// The unparameterised list the nav badge uses still stops at 50.
	w := doRequest(t, handler, http.MethodGet, "/registrations", token, nil)
	var all []map[string]any
	_ = json.NewDecoder(w.Body).Decode(&all)
	if len(all) != 50 {
		t.Errorf("default page = %d rows, want 50", len(all))
	}
}
