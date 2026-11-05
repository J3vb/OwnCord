package admin_test

import (
	"fmt"
	"net/http"
	"testing"
)

// S-04 (B3-8 channel family): every admin channel lookup follows ONE non-DM
// resolution policy — a DM id answers exactly like a missing id, on every
// sibling path. Before this family, the permissions path answered a DM id
// with 400 "DM channels do not support permission overrides", confirming
// precisely what the channels path's 404 was hardened to conceal
// (A-2026-08-02).
func TestS04_DMAndMissingChannelAnswerIdentically(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	dmID := mustCreateChannel(t, database, "", "dm")
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
			requireStatus(t, dm, http.StatusNotFound)
			requireStatus(t, miss, http.StatusNotFound)
			if dm.Body.String() != miss.Body.String() {
				t.Fatalf("DM and missing answers differ:\n  dm:      %s\n  missing: %s", dm.Body.String(), miss.Body.String())
			}
		})
	}
}
