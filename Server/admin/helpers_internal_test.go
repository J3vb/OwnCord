package admin

import (
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
	handlePatchSettings(nil).ServeHTTP(rec, r)
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
