package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// cancelOnAnnounce ends the request context when the report is announced, as a request
// deadline passing right after the report was stored would.
type cancelOnAnnounce struct {
	recordingModQueueBroadcaster
	cancel context.CancelFunc
}

func (b *cancelOnAnnounce) BroadcastModQueue(context.Context, int64, string) { b.cancel() }

func TestFileReport_StoredReportAnswersCreatedAfterTheDeadline(t *testing.T) {
	database := newModQueueActTestDB(t)
	reporterToken, _ := mintSession(t, database, mintUser(t, database, "reporter"))
	targetID := mintUser(t, database, "target")
	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := chi.NewRouter()
	api.MountReportRoutes(r, service.New(database, auth.NewRateLimiter()), &cancelOnAnnounce{cancel: cancel})

	body := `{"target_type":"user","target_id":"` + itoa(targetID) + `","reason":"spam"}`
	req := httptest.NewRequestWithContext(reqCtx, http.MethodPost, "/api/v1/reports", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+reporterToken)
	req.Header.Set("Content-Type", "application/json")
	rec := serveRequest(r, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.ID == "" {
		t.Fatalf("response id = %q, err %v; want a public id", resp.ID, err)
	}
}
