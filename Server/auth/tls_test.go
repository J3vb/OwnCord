package auth_test

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
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

	// Verify validity period is at least 9 years in the future (10y cert).
	minExpiry := time.Now().Add(9 * 365 * 24 * time.Hour)
	if leaf.NotAfter.Before(minExpiry) {
		t.Errorf("cert expires %v, expected at least 9 years from now (%v)", leaf.NotAfter, minExpiry)
	}

	// Verify it is a CA/self-signed cert.
	if !leaf.IsCA {
		t.Error("expected IsCA = true for self-signed cert")
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
