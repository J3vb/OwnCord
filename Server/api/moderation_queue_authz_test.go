package api_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// bearerDo issues an authenticated request with an optional JSON body and
// returns the status and raw response body.
func bearerDo(t *testing.T, h http.Handler, method, path, token string, body []byte) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// TestModerationQueue_AuthorizationBeforeExistence is P1's regression test
// (Codex review of B5-8): resolving a route's public {id} before checking
// CanModerate turns "unknown id" and "real id, caller lacks the bit" into two
// different responses through the handler's own order of operations, even
// though every ReportService method itself checks the permission first. A
// non-holder must see the IDENTICAL status and body for an unknown id and a
// real one, on every one of the four routes that take {id}.
func TestModerationQueue_AuthorizationBeforeExistence(t *testing.T) {
	handler, database := fullRouterWithDB(t)
	ctx := context.Background()

	reporterID := mintUser(t, database, "mqa-reporter")
	subjectID := mintUser(t, database, "mqa-subject")
	nonHolderID := mintUser(t, database, "mqa-nonholder")
	nonHolderToken, _ := mintSession(t, database, nonHolderID)

	const realPublicID = "mqa0000000000000000000000000001"
	if _, err := database.FileReport(ctx, realPublicID, reporterID, subjectID, "user", "1", nil, "spam", "", nil); err != nil {
		t.Fatalf("FileReport: %v", err)
	}
	const unknownPublicID = "mqa-unknown-does-not-exist-000000"

	cases := []struct {
		name   string
		method string
		suffix string
		body   []byte
	}{
		{"get", http.MethodGet, "", nil},
		{"assign", http.MethodPost, "/assign", nil},
		{"note", http.MethodPost, "/notes", []byte(`{"body":"x"}`)},
		{"close", http.MethodPost, "/close", []byte(`{"outcome":"actioned"}`)},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := func(pid string) string { return "/api/v1/moderation/queue/" + pid + c.suffix }

			statusUnknown, bodyUnknown := bearerDo(t, handler, c.method, path(unknownPublicID), nonHolderToken, c.body)
			statusReal, bodyReal := bearerDo(t, handler, c.method, path(realPublicID), nonHolderToken, c.body)

			if statusUnknown != http.StatusForbidden {
				t.Errorf("unknown id: status = %d, want 403 (a non-holder must be refused before any id is resolved)", statusUnknown)
			}
			if statusReal != statusUnknown {
				t.Errorf("status differs: unknown id = %d, real id = %d, want identical", statusUnknown, statusReal)
			}
			if !bytes.Equal(bodyUnknown, bodyReal) {
				t.Errorf("body differs (existence oracle):\n  unknown id = %s\n  real id    = %s", bodyUnknown, bodyReal)
			}
		})
	}
}
