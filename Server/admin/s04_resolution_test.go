package admin_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// S-04 (B3-8 channel family): every admin channel lookup follows ONE non-DM
// resolution policy — a DM id answers exactly like a missing id, on every
// sibling path. Before this family, the permissions path answered a DM id
// with 400 "DM channels do not support permission overrides", confirming
// precisely what the channels path's 404 was hardened to conceal
// (A-2026-08-02).
func TestS04_DMAndMissingChannelAnswerIdentically(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database), newTestSettingsService(database), newTestChannelService(database))
	token := createAdminUser(t, database)

	dmID, err := database.CreateChannel(context.Background(), "", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(dm): %v", err)
	}
	const missingID = 987654

	paths := []struct {
		name, method, path string
		body               any
	}{
		{"patch channel", http.MethodPatch, "/channels/%d", map[string]any{"name": "x"}},
		{"delete channel", http.MethodDelete, "/channels/%d", nil},
		{"get permissions", http.MethodGet, "/channels/%d/permissions", nil},
	}
	for _, p := range paths {
		t.Run(p.name, func(t *testing.T) {
			dm := doRequest(t, handler, p.method, fmt.Sprintf(p.path, dmID), token, p.body)
			miss := doRequest(t, handler, p.method, fmt.Sprintf(p.path, missingID), token, p.body)
			if dm.Code != http.StatusNotFound {
				t.Fatalf("DM id: status = %d, want 404; body: %s", dm.Code, dm.Body.String())
			}
			if miss.Code != http.StatusNotFound {
				t.Fatalf("missing id: status = %d, want 404; body: %s", miss.Code, miss.Body.String())
			}
			if dm.Body.String() != miss.Body.String() {
				t.Fatalf("DM and missing answers differ:\n  dm:      %s\n  missing: %s", dm.Body.String(), miss.Body.String())
			}
		})
	}
}
