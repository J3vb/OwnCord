package admin

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// openMigratedDB opens an in-memory database with the full migration set.
func openMigratedDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// ownerSession creates an Owner user with a login session and returns its id,
// bearer token and the token's hash.
func ownerSession(t *testing.T, database *db.DB) (userID int64, token, tokenHash string) {
	t.Helper()
	userID, err := database.CreateUser(context.Background(), "owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err = auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash = auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return userID, token, tokenHash
}

// mustCreateUser creates a user with the given password hash and role.
func mustCreateUser(t *testing.T, database *db.DB, username, passwordHash string, roleID int) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, passwordHash, roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	return id
}

// soleEntryAttrs requires the ring buffer to hold exactly one entry and
// returns that entry's attributes decoded from JSON.
func soleEntryAttrs(t *testing.T, buf *RingBuffer) map[string]any {
	t.Helper()
	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}
	var attrs map[string]any
	if err := json.Unmarshal([]byte(entries[0].Attrs), &attrs); err != nil {
		t.Fatalf("unmarshal attrs %q: %v", entries[0].Attrs, err)
	}
	return attrs
}

// queryInt's result-set cap belongs to limit parameters only. Clamping offset
// with the same cap means the audit log and user list can never page past row
// maxLimit+limit — the admin panel loops on the same page forever.
func TestQueryInt_OffsetNotClampedByLimitCap(t *testing.T) {
	r := httptest.NewRequest("GET", "/?offset=550", nil)
	if got := queryInt(r, "offset", 0, 0, math.MaxInt32); got != 550 {
		t.Errorf("offset=550 parsed as %d, want 550", got)
	}
}

func TestQueryInt_LimitStillCapped(t *testing.T) {
	r := httptest.NewRequest("GET", "/?limit=9999", nil)
	if got := queryInt(r, "limit", 50, 1, 500); got != 500 {
		t.Errorf("limit=9999 parsed as %d, want the 500 cap", got)
	}
}

// A nil Channels or Settings service must fail closed with a 500, per the
// doc comment on adminRequiredServices, rather than dereference the nil
// pointer and panic (OC-0412).
func TestHandleListChannels_NilServiceUnavailable(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/admin/api/channels", nil)
	rec := httptest.NewRecorder()
	handleListChannels(nil).ServeHTTP(rec, r)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestResolveGuildChannel_NilServiceUnavailable(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/admin/api/channels/1", nil)
	rec := httptest.NewRecorder()
	if ch := resolveGuildChannel(nil, rec, r); ch != nil {
		t.Errorf("resolveGuildChannel(nil, ...) = %v, want nil", ch)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestHandleGetSettings_NilServiceUnavailable(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil)
	rec := httptest.NewRecorder()
	handleGetSettings(nil).ServeHTTP(rec, r)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestHandlePatchSettings_NilServiceUnavailable(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/admin/api/settings", nil)
	rec := httptest.NewRecorder()
	handlePatchSettings(nil, nil, nil).ServeHTTP(rec, r)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestHandleGetAuditLog_NilServiceUnavailable(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/admin/api/audit-log", nil)
	rec := httptest.NewRecorder()
	handleGetAuditLog(nil).ServeHTTP(rec, r)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

// wizardSettingKeys feeds the server_setup audit row's detail (OC-0402): the
// database-backed settings the wizard applied must be named there, since
// ApplyWizardSettings bypasses SettingsService.Patch's own audit write.
func TestWizardSettingKeys_NilWizard(t *testing.T) {
	if got := wizardSettingKeys(nil); got != nil {
		t.Errorf("wizardSettingKeys(nil) = %v, want nil", got)
	}
}

func TestWizardSettingKeys_NamesAppliedSettings(t *testing.T) {
	mode := "open"
	quality := "high"
	wr := &setupWizardRequest{
		RegistrationMode: &mode,
		VoiceQuality:     &quality,
	}
	got := wizardSettingKeys(wr)
	want := []string{"registration_mode", "voice_quality"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("wizardSettingKeys = %v, want %v", got, want)
	}
}
