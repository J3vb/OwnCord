package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/service"
)

func TestWriteAuthError_InternalWithCauseHidesTheCause(t *testing.T) {
	err := fmt.Errorf("%w: failed to read the recovery kit: %w", service.ErrInternal, errors.New("database is locked"))
	rec := httptest.NewRecorder()
	writeAuthError(context.Background(), rec, err)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "locked") {
		t.Errorf("body leaks the cause: %s", rec.Body.String())
	}
}
