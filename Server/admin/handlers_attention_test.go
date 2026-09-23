package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/service"
)

// GET /attention (RI-07) serves the sampler's report to ADMINISTRATOR only
// and fails closed without a service.
func TestAdminAPI_Attention(t *testing.T) {
	database := openAdminTestDB(t)
	svc := newTestServices(database)
	svc.Attention = service.NewAttentionService(service.AttentionThresholds{}, service.AttentionSources{
		DiskFree: func() (uint64, error) { return 10 << 30, nil },
	})
	svc.Attention.Evaluate(context.Background(), time.Now())
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)

	ownerToken := createAdminUser(t, database)
	w := doRequest(t, handler, http.MethodGet, "/attention", ownerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var rep service.AttentionReport
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rep.EvaluatedAt == nil || len(rep.Signals) == 0 || rep.Warnings == nil {
		t.Fatalf("report = %+v, want an evaluated report with signals and a warnings array", rep)
	}

	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	if w := doRequest(t, handler, http.MethodGet, "/attention", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator status = %d, want 403", w.Code)
	}

	bare := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	if w := doRequest(t, bare, http.MethodGet, "/attention", ownerToken, nil); w.Code != http.StatusInternalServerError {
		t.Errorf("no service status = %d, want 500", w.Code)
	}
}
