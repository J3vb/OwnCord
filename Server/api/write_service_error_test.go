package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/service"
)

// ErrDeletedMessage had no writeServiceError case, so removing an
// already-deleted message through the report act route answered a 500 that
// the moderation client renders as an uncertain "Couldn't confirm this
// action". 404 is wrong for this route (the client clears the report on 404),
// so the twin of DUPLICATE_REPORT's 409 is the clean typed refusal.
func TestWriteServiceError_DeletedMessageIsConflict(t *testing.T) {
	rec := httptest.NewRecorder()
	writeServiceError(context.Background(), rec, fmt.Errorf("%w: cannot delete this message", service.ErrDeletedMessage))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v (body %s)", err, rec.Body.String())
	}
	if resp.Error != "ALREADY_DELETED" {
		t.Fatalf("error = %q, want ALREADY_DELETED", resp.Error)
	}
}

// The report-shaped routes call writeReportServiceError, which falls through
// to writeServiceError — the same mapping must reach them, not only the routes
// that call writeServiceError directly.
func TestWriteReportServiceError_DeletedMessageIsConflict(t *testing.T) {
	rec := httptest.NewRecorder()
	writeReportServiceError(context.Background(), rec, fmt.Errorf("%w: cannot delete this message", service.ErrDeletedMessage))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
}
