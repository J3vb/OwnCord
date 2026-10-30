package httperr

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWrite_AnswersTheJSONEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, http.StatusServiceUnavailable, "SERVER_FULL", "server at connection capacity")

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	var got struct{ Error, Message string }
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %v; body=%s", err, rec.Body.String())
	}
	if got.Error != "SERVER_FULL" || got.Message != "server at connection capacity" {
		t.Errorf("body = %+v", got)
	}
}
