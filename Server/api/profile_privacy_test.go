package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

const privacyPath = "/api/v1/users/me/privacy"

func privacyBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return out
}

func TestPrivacy_Unauthenticated(t *testing.T) {
	router := buildUserNoteRouter(newMigratedAuthTestDB(t))
	for _, m := range []string{http.MethodGet, http.MethodPut} {
		rr := noteDo(t, router, m, privacyPath, "", `{"allow_member_dms":true,"message_requests":true}`)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("%s status = %d, want 401", m, rr.Code)
		}
	}
}

func TestPrivacy_DefaultsRoundTripAndReplace(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	router := buildUserNoteRouter(database)
	token := profileCreateToken(t, database, "privacy-user", 4)

	rr := noteDo(t, router, http.MethodGet, privacyPath, token, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("GET status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if got := privacyBody(t, rr.Body.String()); got["allow_member_dms"] != true || got["message_requests"] != true || len(got) != 2 {
		t.Errorf("default body = %v, want both true", got)
	}

	rr = noteDo(t, router, http.MethodPut, privacyPath, token, `{"allow_member_dms":false,"message_requests":true}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if got := privacyBody(t, rr.Body.String()); got["allow_member_dms"] != false || got["message_requests"] != true {
		t.Errorf("PUT body = %v", got)
	}
	rr = noteDo(t, router, http.MethodGet, privacyPath, token, "")
	if got := privacyBody(t, rr.Body.String()); got["allow_member_dms"] != false || got["message_requests"] != true {
		t.Errorf("GET after PUT = %v", got)
	}

	// A second PUT replaces the whole row.
	noteDo(t, router, http.MethodPut, privacyPath, token, `{"allow_member_dms":true,"message_requests":false}`)
	rr = noteDo(t, router, http.MethodGet, privacyPath, token, "")
	if got := privacyBody(t, rr.Body.String()); got["allow_member_dms"] != true || got["message_requests"] != false {
		t.Errorf("GET after second PUT = %v", got)
	}
}

func TestPrivacy_OwnerOnly(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	router := buildUserNoteRouter(database)
	a := profileCreateToken(t, database, "privacy-a", 4)
	b := profileCreateToken(t, database, "privacy-b", 4)

	noteDo(t, router, http.MethodPut, privacyPath, a, `{"allow_member_dms":false,"message_requests":false}`)
	rr := noteDo(t, router, http.MethodGet, privacyPath, b, "")
	if got := privacyBody(t, rr.Body.String()); got["allow_member_dms"] != true || got["message_requests"] != true {
		t.Errorf("another user's GET = %v, want defaults", got)
	}
}

func TestPrivacy_RejectsBadBodies(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	router := buildUserNoteRouter(database)
	token := profileCreateToken(t, database, "privacy-bad", 4)

	for name, body := range map[string]string{
		"missing message_requests": `{"allow_member_dms":false}`,
		"missing allow_member_dms": `{"message_requests":false}`,
		"empty object":             `{}`,
		"unknown field":            `{"allow_member_dms":true,"message_requests":true,"extra":1}`,
		"wrong type":               `{"allow_member_dms":"no","message_requests":true}`,
		"null value":               `{"allow_member_dms":null,"message_requests":true}`,
		"not json":                 `nope`,
		"empty body":               ``,
		"trailing object":          `{"allow_member_dms":false,"message_requests":false}{"x":1}`,
		"trailing garbage":         `{"allow_member_dms":false,"message_requests":false} garbage`,
	} {
		rr := noteDo(t, router, http.MethodPut, privacyPath, token, body)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, rr.Code)
		}
	}
	// Nothing was stored by the refused bodies.
	rr := noteDo(t, router, http.MethodGet, privacyPath, token, "")
	if got := privacyBody(t, rr.Body.String()); got["allow_member_dms"] != true || got["message_requests"] != true {
		t.Errorf("after refused bodies = %v, want defaults", got)
	}
}

func TestPrivacy_RateLimited(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, service.New(database, limiter), nil, limiter, nil, nil, nil)
	token := profileCreateToken(t, database, "privacy-limit", 4)

	last := 0
	for i := 0; i < 40 && last != http.StatusTooManyRequests; i++ {
		last = noteDo(t, r, http.MethodPut, privacyPath, token, `{"allow_member_dms":true,"message_requests":true}`).Code
	}
	if last != http.StatusTooManyRequests {
		t.Errorf("PUT never rate limited, last status = %d", last)
	}
}

func TestPrivacy_NotInProfileResponse(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "privacy-profile", 4)
	noteDo(t, router, http.MethodPut, privacyPath, token, `{"allow_member_dms":false,"message_requests":false}`)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "privacy-renamed"})
	if rr.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d; body = %s", rr.Code, rr.Body.String())
	}
	for _, key := range []string{"allow_member_dms", "message_requests"} {
		if strings.Contains(rr.Body.String(), key) {
			t.Errorf("profile payload carries %q", key)
		}
	}
}
