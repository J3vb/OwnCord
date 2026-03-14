package auth_test

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
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

	tlsCfg, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate() error: %v", err)
	}
	if tlsCfg == nil {
		t.Fatal("LoadOrGenerate() returned nil tls.Config")
	}
	if len(tlsCfg.Certificates) == 0 {
		t.Error("LoadOrGenerate() returned tls.Config with no certificates")
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
	tlsCfg, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate() error: %v", err)
	}
	if len(tlsCfg.Certificates) == 0 {
		t.Error("LoadOrGenerate() returned no certificates")
	}
}

func TestLoadOrGenerateModeOff(t *testing.T) {
	cfg := config.TLSConfig{Mode: "off"}

	tlsCfg, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(mode=off) error: %v", err)
	}
	if tlsCfg != nil {
		t.Error("LoadOrGenerate(mode=off) should return nil tls.Config")
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

	tlsCfg, err := auth.LoadOrGenerate(cfg)
	if err != nil {
		t.Fatalf("LoadOrGenerate(mode=manual) error: %v", err)
	}
	if len(tlsCfg.Certificates) == 0 {
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
