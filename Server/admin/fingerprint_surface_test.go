package admin_test

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
)

// serveCert installs a fixed served certificate for the test and clears it
// afterwards.
func serveCert(t *testing.T, mode, fp string) {
	t.Helper()
	admin.SetServedCertificate(mode, func() auth.ServedCert { return auth.ServedCert{Fingerprint: fp} })
	t.Cleanup(func() { admin.SetServedCertificate("", nil) })
}

// OP-01: the served leaf certificate's fingerprint must be reachable from the
// admin panel, not only the stderr banner, so an operator who cannot watch
// start-up output can still publish it for users to compare out of band. It
// appears on the dashboard payload and on the setup wizard's finish step.

func TestAdminAPI_Stats_CarriesCertificateFingerprint(t *testing.T) {
	const fp = "aa:bb:cc:dd"
	serveCert(t, "self_signed", fp)

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
	serveCert(t, "acme", "")

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
	serveCert(t, "self_signed", fp)

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
	serveCert(t, "self_signed", "11:22:33:44")

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

// statsFor fetches the dashboard payload as a generic map.
func statsFor(t *testing.T) map[string]any {
	t.Helper()
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
	return stats
}

// In acme mode the certificate is learned on the first handshake and
// replaced on every renewal: the dashboard shows whatever is served now,
// with its expiry, and names the mode so the panel can explain an absence.
func TestAdminAPI_Stats_FollowsTheServedCertificate(t *testing.T) {
	served := auth.ServedCert{}
	admin.SetServedCertificate("acme", func() auth.ServedCert { return served })
	t.Cleanup(func() { admin.SetServedCertificate("", nil) })

	stats := statsFor(t)
	if stats["tls_mode"] != "acme" {
		t.Errorf("tls_mode = %v, want acme", stats["tls_mode"])
	}
	if _, present := stats["certificate_fingerprint"]; present {
		t.Error("acme before its first handshake must omit the fingerprint")
	}
	if _, present := stats["certificate_expires_at"]; present {
		t.Error("acme before its first handshake must omit the expiry")
	}

	served = auth.ServedCert{Fingerprint: "aa:bb", NotAfter: time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)}
	stats = statsFor(t)
	if stats["certificate_fingerprint"] != "aa:bb" {
		t.Errorf("certificate_fingerprint = %v, want aa:bb", stats["certificate_fingerprint"])
	}
	if stats["certificate_expires_at"] != "2026-12-01T00:00:00Z" {
		t.Errorf("certificate_expires_at = %v, want 2026-12-01T00:00:00Z", stats["certificate_expires_at"])
	}

	// A renewal shows up without a restart.
	served = auth.ServedCert{Fingerprint: "cc:dd", NotAfter: time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC)}
	if got := statsFor(t)["certificate_fingerprint"]; got != "cc:dd" {
		t.Errorf("after renewal certificate_fingerprint = %v, want cc:dd", got)
	}
}

// With TLS off a reverse proxy owns the certificate: the payload says so,
// and claims no fingerprint the server cannot see.
func TestAdminAPI_Stats_NamesTLSOff(t *testing.T) {
	serveCert(t, "off", "")
	stats := statsFor(t)
	if stats["tls_mode"] != "off" {
		t.Errorf("tls_mode = %v, want off", stats["tls_mode"])
	}
	if _, present := stats["certificate_fingerprint"]; present {
		t.Error("TLS off must omit the fingerprint")
	}
}
