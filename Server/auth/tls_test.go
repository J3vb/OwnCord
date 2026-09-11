package auth_test

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
)

func TestGenerateSelfSignedCreatesFiles(t *testing.T) {
	tmpDir := t.TempDir()
	certFile := filepath.Join(tmpDir, "cert.pem")
	keyFile := filepath.Join(tmpDir, "key.pem")

	if err := auth.GenerateSelfSigned(certFile, keyFile); err != nil {
		t.Fatalf("GenerateSelfSigned() error: %v", err)
	}

	if _, err := os.Stat(certFile); os.IsNotExist(err) {
		t.Error("cert.pem not created")
	}
	if _, err := os.Stat(keyFile); os.IsNotExist(err) {
		t.Error("key.pem not created")
	}
}

func TestGenerateSelfSignedProducesValidCert(t *testing.T) {
	tmpDir := t.TempDir()
	certFile := filepath.Join(tmpDir, "cert.pem")
	keyFile := filepath.Join(tmpDir, "key.pem")

	if err := auth.GenerateSelfSigned(certFile, keyFile); err != nil {
		t.Fatalf("GenerateSelfSigned() error: %v", err)
	}

	// Load the generated cert/key pair.
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		t.Fatalf("tls.LoadX509KeyPair error: %v", err)
	}

	// Parse the leaf certificate.
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatalf("x509.ParseCertificate error: %v", err)
	}

	// Verify validity period is ~2 years (not the old 10y).
	minExpiry := time.Now().Add(1 * 365 * 24 * time.Hour)
	maxExpiry := time.Now().Add(3 * 365 * 24 * time.Hour)
	if leaf.NotAfter.Before(minExpiry) {
		t.Errorf("cert expires %v, expected at least 1 year from now (%v)", leaf.NotAfter, minExpiry)
	}
	if leaf.NotAfter.After(maxExpiry) {
		t.Errorf("cert expires %v, expected at most 3 years from now (%v)", leaf.NotAfter, maxExpiry)
	}

	// BUG-138: Leaf cert must NOT be a CA — prevents signing other certs on key compromise.
	if leaf.IsCA {
		t.Error("expected IsCA = false for self-signed leaf cert")
	}
	if leaf.KeyUsage&x509.KeyUsageCertSign != 0 {
		t.Error("leaf cert should not have KeyUsageCertSign")
	}
}

func TestGenerateSelfSignedInvalidCertPath(t *testing.T) {
	err := auth.GenerateSelfSigned("/nonexistent/dir/cert.pem", "/nonexistent/dir/key.pem")
	if err == nil {
		t.Error("GenerateSelfSigned() should error for invalid cert path")
	}
}

func TestGenerateSelfSignedInvalidKeyPath(t *testing.T) {
	tmpDir := t.TempDir()
	certFile := filepath.Join(tmpDir, "cert.pem")

	// Key path in non-existent dir.
	err := auth.GenerateSelfSigned(certFile, "/nonexistent/dir/key.pem")
	if err == nil {
		t.Error("GenerateSelfSigned() should error for invalid key path")
	}
}

func TestLoadOrGenerateSelfSigned(t *testing.T) {
	tmpDir := t.TempDir()
	certFile := filepath.Join(tmpDir, "cert.pem")
	keyFile := filepath.Join(tmpDir, "key.pem")

	cfg := config.TLSConfig{
		Mode:     "self_signed",
		CertFile: certFile,
		KeyFile:  keyFile,
	}

	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate() error: %v", err)
	}
	if result.TLSConfig == nil {
		t.Fatal("LoadOrGenerate() returned nil TLSConfig")
	}
	if len(result.TLSConfig.Certificates) == 0 {
		t.Error("LoadOrGenerate() returned TLSConfig with no certificates")
	}
	if result.HTTPHandler != nil {
		t.Error("self_signed mode should not set HTTPHandler")
	}
}

func TestLoadOrGenerateLoadsExistingCert(t *testing.T) {
	tmpDir := t.TempDir()
	certFile := filepath.Join(tmpDir, "cert.pem")
	keyFile := filepath.Join(tmpDir, "key.pem")

	// Generate a cert first.
	if err := auth.GenerateSelfSigned(certFile, keyFile); err != nil {
		t.Fatalf("GenerateSelfSigned() error: %v", err)
	}

	cfg := config.TLSConfig{
		Mode:     "self_signed",
		CertFile: certFile,
		KeyFile:  keyFile,
	}

	// Load the existing cert (should not regenerate).
	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate() error: %v", err)
	}
	if len(result.TLSConfig.Certificates) == 0 {
		t.Error("LoadOrGenerate() returned no certificates")
	}
}

func TestLoadOrGenerateModeOff(t *testing.T) {
	cfg := config.TLSConfig{Mode: "off"}

	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(mode=off) error: %v", err)
	}
	if result.TLSConfig != nil {
		t.Error("LoadOrGenerate(mode=off) should return nil TLSConfig")
	}
}

func TestLoadOrGenerateModeManualMissingFiles(t *testing.T) {
	cfg := config.TLSConfig{
		Mode:     "manual",
		CertFile: "/nonexistent/cert.pem",
		KeyFile:  "/nonexistent/key.pem",
	}

	_, err := auth.LoadOrGenerate(cfg)
	if err == nil {
		t.Error("LoadOrGenerate(mode=manual) should error when cert/key don't exist")
	}
}

func TestLoadOrGenerateModeManualValidFiles(t *testing.T) {
	tmpDir := t.TempDir()
	certFile := filepath.Join(tmpDir, "cert.pem")
	keyFile := filepath.Join(tmpDir, "key.pem")

	// Pre-generate cert files.
	if err := auth.GenerateSelfSigned(certFile, keyFile); err != nil {
		t.Fatalf("GenerateSelfSigned() error: %v", err)
	}

	cfg := config.TLSConfig{
		Mode:     "manual",
		CertFile: certFile,
		KeyFile:  keyFile,
	}

	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(mode=manual) error: %v", err)
	}
	if len(result.TLSConfig.Certificates) == 0 {
		t.Error("LoadOrGenerate(mode=manual) returned no certificates")
	}
}

func TestLoadOrGenerateUnknownMode(t *testing.T) {
	cfg := config.TLSConfig{Mode: "unknown_mode"}

	_, err := auth.LoadOrGenerate(cfg)
	if err == nil {
		t.Error("LoadOrGenerate() should error for unknown TLS mode")
	}
}

// ── ACME mode tests ───────────────────────────────────────────────────────

func TestLoadOrGenerateACME_MissingDomain(t *testing.T) {
	cfg := config.TLSConfig{Mode: "acme", Domain: ""}

	_, err := auth.LoadOrGenerate(cfg)
	if err == nil {
		t.Fatal("expected error for ACME mode without domain")
	}
	if !strings.Contains(err.Error(), "domain") {
		t.Errorf("error should mention domain, got: %v", err)
	}
}

func TestLoadOrGenerateACME_IPAddress(t *testing.T) {
	cfg := config.TLSConfig{Mode: "acme", Domain: "192.168.1.1"}

	_, err := auth.LoadOrGenerate(cfg)
	if err == nil {
		t.Fatal("expected error for ACME mode with IP address")
	}
	if !strings.Contains(err.Error(), "IP address") {
		t.Errorf("error should mention IP address, got: %v", err)
	}
}

func TestLoadOrGenerateACME_WildcardDomain(t *testing.T) {
	cfg := config.TLSConfig{Mode: "acme", Domain: "*.example.com"}

	_, err := auth.LoadOrGenerate(cfg)
	if err == nil {
		t.Fatal("expected error for ACME mode with wildcard domain")
	}
	if !strings.Contains(err.Error(), "wildcard") {
		t.Errorf("error should mention wildcard, got: %v", err)
	}
}

func TestLoadOrGenerateACME_ValidDomain(t *testing.T) {
	tmpDir := t.TempDir()
	cacheDir := filepath.Join(tmpDir, "acme_certs")

	cfg := config.TLSConfig{
		Mode:         "acme",
		Domain:       "chat.example.com",
		AcmeCacheDir: cacheDir,
	}

	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(acme) error: %v", err)
	}
	if result.TLSConfig == nil {
		t.Fatal("ACME mode should return non-nil TLSConfig")
	}
	if result.TLSConfig.GetCertificate == nil {
		t.Error("ACME TLSConfig should have GetCertificate set")
	}
	if result.HTTPHandler == nil {
		t.Error("ACME mode should return non-nil HTTPHandler")
	}

	// Verify cache directory was created.
	if _, err := os.Stat(cacheDir); os.IsNotExist(err) {
		t.Error("ACME cache directory was not created")
	}
}

func TestLoadOrGenerateACME_HTTPRedirect(t *testing.T) {
	tmpDir := t.TempDir()
	cfg := config.TLSConfig{
		Mode:         "acme",
		Domain:       "chat.example.com",
		AcmeCacheDir: filepath.Join(tmpDir, "acme_certs"),
	}

	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(acme) error: %v", err)
	}

	// Non-challenge requests should redirect to HTTPS.
	req := httptest.NewRequest(http.MethodGet, "http://chat.example.com/some/path", nil)
	rec := httptest.NewRecorder()
	result.HTTPHandler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMovedPermanently {
		t.Errorf("expected 301 redirect, got %d", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://chat.example.com/") {
		t.Errorf("redirect should point to HTTPS, got: %s", loc)
	}
}

func TestLoadOrGenerateACME_HTTPRedirectNonDefaultPort(t *testing.T) {
	tmpDir := t.TempDir()
	cfg := config.TLSConfig{
		Mode:         "acme",
		Domain:       "chat.example.com",
		AcmeCacheDir: filepath.Join(tmpDir, "acme_certs"),
		HTTPSPort:    8443,
	}

	result, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(acme) error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://chat.example.com/some/path", nil)
	rec := httptest.NewRecorder()
	result.HTTPHandler.ServeHTTP(rec, req)

	loc := rec.Header().Get("Location")
	if want := "https://chat.example.com:8443/some/path"; loc != want {
		t.Errorf("redirect Location = %q, want %q", loc, want)
	}
}

// ─── B6-6: reachability failures must not be silent ─────────────────────────

// TestLoadACME_IPErrorNamesTheRealLimit — the error used to read "Let's
// Encrypt does not issue certificates for IP addresses". That stopped being
// true on 2026-01-15, and blaming the CA sends an owner to the wrong place:
// the limit is this build's ACME client, which accepts hostnames only.
func TestLoadACME_IPErrorNamesTheRealLimit(t *testing.T) {
	for _, ip := range []string{"192.168.1.1", "203.0.113.10", "2001:db8::1"} {
		_, err := auth.LoadOrGenerate(config.TLSConfig{Mode: "acme", Domain: ip})
		if err == nil {
			t.Fatalf("%s: expected an error for an IP in tls.domain", ip)
		}
		msg := err.Error()
		if !strings.Contains(msg, "IP address") {
			t.Errorf("%s: error should still name the IP-address case, got: %v", ip, err)
		}
		if strings.Contains(msg, "Let's Encrypt does not issue") {
			t.Errorf("%s: error blames the CA for a limit that is this build's own: %v", ip, err)
		}
		for _, want := range []string{"hostname", "manual"} {
			if !strings.Contains(strings.ToLower(msg), want) {
				t.Errorf("%s: error does not point at %q as the way forward: %v", ip, want, err)
			}
		}
	}
}

// TestLoadACME_LogsIssuanceFailureWithReachabilityCause — the server discards
// its TLS ErrorLog (Server/internal/app/lifecycle.go) to suppress handshake
// noise, which also discarded every certificate-issuance failure. A server
// whose port 80 is unreachable logged "server starting", looked healthy, and
// failed every handshake in silence: a reachability limit reported as
// application success, which is the thing B6-6 exists to stop.
//
// The failure is injected. Reaching a real ACME directory from a test would
// make this depend on network topology, which this milestone's plan forbids.
func TestLoadACME_LogsIssuanceFailureWithReachabilityCause(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	boom := errors.New("acme/autocert: unable to satisfy authorization")
	wrapped := auth.LogCertificateFailuresForTest(func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return nil, boom
	}, "chat.example.com")

	if _, err := wrapped(&tls.ClientHelloInfo{ServerName: "chat.example.com"}); !errors.Is(err, boom) {
		t.Fatalf("the wrapper must return the underlying error unchanged, got: %v", err)
	}

	logged := buf.String()
	for _, want := range []string{"chat.example.com", ":80", "certificate"} {
		if !strings.Contains(logged, want) {
			t.Errorf("issuance-failure log does not mention %q:\n%s", want, logged)
		}
	}

	// Logged once per domain, not once per handshake: a client retrying a
	// failing connection must not be able to fill the disk.
	before := buf.Len()
	for range 5 {
		_, _ = wrapped(&tls.ClientHelloInfo{ServerName: "chat.example.com"})
	}
	if buf.Len() != before {
		t.Errorf("the wrapper logged again on repeat failures; %d extra bytes", buf.Len()-before)
	}
}

// TestLoadACME_SuccessIsNotLogged — a working certificate path stays quiet.
func TestLoadACME_SuccessIsNotLogged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	wrapped := auth.LogCertificateFailuresForTest(func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return &tls.Certificate{}, nil
	}, "chat.example.com")

	if _, err := wrapped(&tls.ClientHelloInfo{ServerName: "chat.example.com"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if buf.Len() != 0 {
		t.Errorf("a successful issuance logged something:\n%s", buf.String())
	}
}
