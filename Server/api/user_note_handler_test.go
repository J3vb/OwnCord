package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

func buildUserNoteRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, service.New(database, limiter), nil, limiter, nil, nil, nil)
	return r
}

func noteDo(t *testing.T, router http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func noteBody(t *testing.T, rr *httptest.ResponseRecorder) (int64, string) {
	t.Helper()
	var out struct {
		UserID int64  `json:"user_id"`
		Note   string `json:"note"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", rr.Body.String(), err)
	}
	return out.UserID, out.Note
}

func noteUserID(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	u, err := database.GetUserByUsername(context.Background(), name)
	if err != nil || u == nil {
		t.Fatalf("lookup %s: %v", name, err)
	}
	return u.ID
}

func notePath(id int64) string { return fmt.Sprintf("/api/v1/users/me/notes/%d", id) }

func TestUserNote_RequiresAuth(t *testing.T) {
	router := buildUserNoteRouter(newMigratedAuthTestDB(t))
	for _, m := range []string{http.MethodGet, http.MethodPut} {
		if rr := noteDo(t, router, m, notePath(1), "", `{"note":"x"}`); rr.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", m, rr.Code)
		}
	}
}

func TestUserNote_GetMissingIsEmpty(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "note_owner", 4)
	profileCreateToken(t, database, "note_target", 4)
	target := noteUserID(t, database, "note_target")
	router := buildUserNoteRouter(database)

	rr := noteDo(t, router, http.MethodGet, notePath(target), token, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rr.Code, rr.Body.String())
	}
	if id, note := noteBody(t, rr); id != target || note != "" {
		t.Errorf("body = (%d, %q), want (%d, \"\")", id, note, target)
	}
	// An id that does not exist reads the same way: GET reveals nothing.
	rr = noteDo(t, router, http.MethodGet, notePath(987654), token, "")
	if rr.Code != http.StatusOK {
		t.Errorf("GET for an unknown id = %d, want 200", rr.Code)
	}
}

func TestUserNote_PutTrimsAndCaps(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "cap_owner", 4)
	profileCreateToken(t, database, "cap_target", 4)
	target := noteUserID(t, database, "cap_target")
	router := buildUserNoteRouter(database)

	put := func(note string) *httptest.ResponseRecorder {
		b, _ := json.Marshal(map[string]string{"note": note})
		return noteDo(t, router, http.MethodPut, notePath(target), token, string(b))
	}
	cases := []struct {
		name   string
		note   string
		status int
		want   string
	}{
		{"trimmed", "  hello  ", http.StatusOK, "hello"},
		{"256 runes ok", strings.Repeat("é", 256), http.StatusOK, strings.Repeat("é", 256)},
		{"257 runes refused", strings.Repeat("a", 257), http.StatusBadRequest, ""},
		{"1025 bytes refused before cleaning", strings.Repeat(" ", 1025), http.StatusBadRequest, ""},
		{"1024 spaces clean to empty", strings.Repeat(" ", 1024), http.StatusOK, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := put(tc.note)
			if rr.Code != tc.status {
				t.Fatalf("status = %d (%s), want %d", rr.Code, rr.Body.String(), tc.status)
			}
			if tc.status == http.StatusOK {
				if _, got := noteBody(t, rr); got != tc.want {
					t.Errorf("stored = %q, want %q", got, tc.want)
				}
			}
		})
	}
}

func TestUserNote_EmptyDeletes(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "del_owner", 4)
	profileCreateToken(t, database, "del_target", 4)
	target := noteUserID(t, database, "del_target")
	owner := noteUserID(t, database, "del_owner")
	router := buildUserNoteRouter(database)

	if rr := noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"keep"}`); rr.Code != http.StatusOK {
		t.Fatalf("put = %d", rr.Code)
	}
	if rr := noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"   "}`); rr.Code != http.StatusOK {
		t.Fatalf("empty put = %d", rr.Code)
	}
	var n int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM user_notes WHERE owner_id = ? AND target_id = ?`, owner, target).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows after empty put = %d (%v), want 0", n, err)
	}
}

func TestUserNote_OwnerScoped(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	tokenA := profileCreateToken(t, database, "scope_a", 4)
	tokenB := profileCreateToken(t, database, "scope_b", 4)
	profileCreateToken(t, database, "scope_c", 4)
	c := noteUserID(t, database, "scope_c")
	router := buildUserNoteRouter(database)

	if rr := noteDo(t, router, http.MethodPut, notePath(c), tokenA, `{"note":"a thinks"}`); rr.Code != http.StatusOK {
		t.Fatalf("A put = %d", rr.Code)
	}
	rr := noteDo(t, router, http.MethodGet, notePath(c), tokenB, "")
	if _, note := noteBody(t, rr); note != "" {
		t.Errorf("B read A's note about C: %q", note)
	}
	// B writes its own; A's stays.
	if rr := noteDo(t, router, http.MethodPut, notePath(c), tokenB, `{"note":"b thinks"}`); rr.Code != http.StatusOK {
		t.Fatalf("B put = %d", rr.Code)
	}
	if _, note := noteBody(t, noteDo(t, router, http.MethodGet, notePath(c), tokenA, "")); note != "a thinks" {
		t.Errorf("A's note = %q after B wrote", note)
	}
}

func TestUserNote_UnknownTarget404(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "nf_owner", 4)
	router := buildUserNoteRouter(database)
	for _, body := range []string{`{"note":"x"}`, `{"note":""}`} {
		if rr := noteDo(t, router, http.MethodPut, notePath(987654), token, body); rr.Code != http.StatusNotFound {
			t.Errorf("PUT %s unknown target = %d, want 404", body, rr.Code)
		}
	}
	if rr := noteDo(t, router, http.MethodPut, "/api/v1/users/me/notes/abc", token, `{"note":"x"}`); rr.Code != http.StatusBadRequest {
		t.Errorf("non-numeric id = %d, want 400", rr.Code)
	}
}

func TestUserNote_ErasedTargetThen404(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "er_owner", 4)
	profileCreateToken(t, database, "er_target", 4)
	target := noteUserID(t, database, "er_target")
	router := buildUserNoteRouter(database)
	if rr := noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"x"}`); rr.Code != http.StatusOK {
		t.Fatalf("put = %d", rr.Code)
	}
	if _, err := database.EraseAccount(context.Background(), target, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if rr := noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"again"}`); rr.Code != http.StatusNotFound {
		t.Errorf("PUT after erasure = %d, want 404", rr.Code)
	}
	if _, note := noteBody(t, noteDo(t, router, http.MethodGet, notePath(target), token, "")); note != "" {
		t.Errorf("note survived the erasure: %q", note)
	}
}

func TestUserNote_ConcurrentWritersLastWins(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "race_owner", 4)
	profileCreateToken(t, database, "race_target", 4)
	target := noteUserID(t, database, "race_target")
	router := buildUserNoteRouter(database)
	type result struct {
		want string
		rr   *httptest.ResponseRecorder
	}
	done := make(chan result, 2)
	for _, text := range []string{"device one", "device two"} {
		go func() {
			done <- result{text, noteDo(t, router, http.MethodPut, notePath(target), token, fmt.Sprintf(`{"note":%q}`, text))}
		}()
	}
	for range 2 {
		r := <-done
		if _, got := noteBody(t, r.rr); got != r.want {
			t.Errorf("writer got back %q, want its own %q", got, r.want)
		}
	}
	_, final := noteBody(t, noteDo(t, router, http.MethodGet, notePath(target), token, ""))
	if final != "device one" && final != "device two" {
		t.Errorf("final note = %q, want one of the two writes", final)
	}
}

func TestUserNote_RateLimited(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "rl_owner", 4)
	profileCreateToken(t, database, "rl_target", 4)
	target := noteUserID(t, database, "rl_target")
	router := buildUserNoteRouter(database)
	var last int
	for range 40 {
		last = noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"x"}`).Code
		if last == http.StatusTooManyRequests {
			return
		}
	}
	t.Errorf("40 writes never hit the limiter (last status %d)", last)
}

func TestUserNote_PutWithoutNoteFieldRefused(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "nf_owner", 4)
	profileCreateToken(t, database, "nf_target", 4)
	target := noteUserID(t, database, "nf_target")
	router := buildUserNoteRouter(database)
	if rr := noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"keep me"}`); rr.Code != http.StatusOK {
		t.Fatalf("seed status = %d", rr.Code)
	}
	for _, body := range []string{`{}`, `{"note":null}`, `{"note":5}`, `{"text":""}`} {
		if rr := noteDo(t, router, http.MethodPut, notePath(target), token, body); rr.Code != http.StatusBadRequest {
			t.Errorf("PUT %s status = %d, want 400", body, rr.Code)
		}
	}
	if _, got := noteBody(t, noteDo(t, router, http.MethodGet, notePath(target), token, "")); got != "keep me" {
		t.Errorf("note after refused PUTs = %q, want it kept", got)
	}
}

func TestUserNote_MaxLengthEscapedBodyAccepted(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "esc_owner", 4)
	profileCreateToken(t, database, "esc_target", 4)
	target := noteUserID(t, database, "esc_target")
	router := buildUserNoteRouter(database)
	note := strings.Repeat("\U0001F600", 256)
	var esc strings.Builder
	for _, r := range note {
		r1, r2 := utf16.EncodeRune(r)
		fmt.Fprintf(&esc, `\u%04x\u%04x`, r1, r2)
	}
	rr := noteDo(t, router, http.MethodPut, notePath(target), token, `{"note":"`+esc.String()+`"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("256 escaped astral runes status = %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	if _, got := noteBody(t, rr); got != note {
		t.Errorf("stored note differs from sent note")
	}
}
