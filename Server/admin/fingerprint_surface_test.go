package admin_test

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// OP-01: the served leaf certificate's fingerprint must be reachable from the
// admin panel, not only the stderr banner, so an operator who cannot watch
// start-up output can still publish it for users to compare out of band. It
// appears on the dashboard payload and on the setup wizard's finish step.

func TestAdminAPI_Stats_CarriesCertificateFingerprint(t *testing.T) {
	const fp = "aa:bb:cc:dd"
	admin.SetLeafFingerprint(fp)
	t.Cleanup(func() { admin.SetLeafFingerprint("") })

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /stats = %d, want 200", w.Code)
	}
	var stats struct {
		CertificateFingerprint string `json:"certificate_fingerprint"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if stats.CertificateFingerprint != fp {
		t.Errorf("certificate_fingerprint = %q, want %q", stats.CertificateFingerprint, fp)
	}
}

func TestAdminAPI_Stats_OmitsFingerprintWhenUnknown(t *testing.T) {
	admin.SetLeafFingerprint("")
	t.Cleanup(func() { admin.SetLeafFingerprint("") })

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /stats = %d, want 200", w.Code)
	}
	var stats map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := stats["certificate_fingerprint"]; present {
		t.Error("an unknown fingerprint (TLS off / ACME) must be omitted, not sent empty")
	}
}

func TestSetup_FinishStepCarriesCertificateFingerprint(t *testing.T) {
	const fp = "11:22:33:44"
	admin.SetLeafFingerprint(fp)
	t.Cleanup(func() { admin.SetLeafFingerprint("") })

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	rr := doRequest(t, handler, http.MethodPost, "/setup", "", map[string]string{
		"username": "myadmin",
		"password": "SecurePass123!",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	var resp struct {
		CertificateFingerprint string `json:"certificate_fingerprint"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.CertificateFingerprint != fp {
		t.Errorf("setup certificate_fingerprint = %q, want %q", resp.CertificateFingerprint, fp)
	}
}

func TestSetup_FinishStepOmitsFingerprintWhenWizardChangesTLSMode(t *testing.T) {
	admin.SetLeafFingerprint("11:22:33:44")
	t.Cleanup(func() { admin.SetLeafFingerprint("") })

	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	handler := wizardHandler(t, database, cfgPath, make(chan string, 1))

	rr := doRequest(t, handler, http.MethodPost, "/setup", "", map[string]any{
		"username": "myadmin",
		"password": "SecurePass123!",
		"wizard":   map[string]any{"tls_mode": "manual"},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if fp, present := resp["certificate_fingerprint"]; present {
		t.Errorf("certificate_fingerprint = %v; the restart serves a different certificate, so it must be omitted", fp)
	}
}
