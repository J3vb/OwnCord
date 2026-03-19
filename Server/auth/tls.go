// Package auth provides authentication and TLS helpers for the OwnCord server.
package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/owncord/server/config"
)

// TLSResult holds the output of LoadOrGenerate.
// For most TLS modes only TLSConfig is set. In ACME mode, HTTPHandler is
// also set and must be served on :80 for HTTP-01 challenges and redirect.
type TLSResult struct {
	TLSConfig   *tls.Config
	HTTPHandler http.Handler // non-nil only for ACME mode
}

// GenerateSelfSigned generates an ECDSA P-256 self-signed TLS certificate
// valid for 10 years and writes the PEM-encoded cert and key to the given
// file paths.
//
// ECDSA P-256 is preferred over RSA 4096 for performance — it provides
// equivalent security at a fraction of the key generation cost, which matters
// for server startup and test speed.
func GenerateSelfSigned(certFile, keyFile string) error {
	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generating ECDSA key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("generating serial number: %w", err)
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"OwnCord Server"},
			CommonName:   "OwnCord Self-Signed",
		},
		NotBefore:             now,
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &privKey.PublicKey, privKey)
	if err != nil {
		return fmt.Errorf("creating certificate: %w", err)
	}

	if err := writePEM(certFile, "CERTIFICATE", certDER); err != nil {
		return fmt.Errorf("writing cert file: %w", err)
	}

	keyDER, err := x509.MarshalECPrivateKey(privKey)
	if err != nil {
		return fmt.Errorf("marshalling EC private key: %w", err)
	}

	if err := writePEM(keyFile, "EC PRIVATE KEY", keyDER); err != nil {
		return fmt.Errorf("writing key file: %w", err)
	}

	return nil
}

// LoadOrGenerate returns a *TLSResult based on the TLS configuration mode:
//   - "self_signed": loads existing cert/key or generates new ones
//   - "manual": loads existing cert/key from CertFile/KeyFile paths
//   - "off": returns nil TLSConfig (TLS disabled)
//   - "acme": obtains Let's Encrypt certificate via ACME; HTTPHandler must be served on :80
func LoadOrGenerate(cfg config.TLSConfig) (*TLSResult, error) {
	switch cfg.Mode {
	case "off":
		return &TLSResult{}, nil

	case "self_signed":
		tlsCfg, err := loadOrGenerateSelfSigned(cfg)
		if err != nil {
			return nil, err
		}
		return &TLSResult{TLSConfig: tlsCfg}, nil

	case "manual":
		tlsCfg, err := loadCertPair(cfg.CertFile, cfg.KeyFile)
		if err != nil {
			return nil, err
		}
		return &TLSResult{TLSConfig: tlsCfg}, nil

	case "acme":
		return loadACME(cfg)

	default:
		return nil, fmt.Errorf("unknown TLS mode: %q", cfg.Mode)
	}
}

// loadOrGenerateSelfSigned loads the cert/key if both files exist, otherwise
// generates a new self-signed pair.
func loadOrGenerateSelfSigned(cfg config.TLSConfig) (*tls.Config, error) {
	certExists := fileExists(cfg.CertFile)
	keyExists := fileExists(cfg.KeyFile)

	if !certExists || !keyExists {
		if err := GenerateSelfSigned(cfg.CertFile, cfg.KeyFile); err != nil {
			return nil, fmt.Errorf("generating self-signed cert: %w", err)
		}
	}

	return loadCertPair(cfg.CertFile, cfg.KeyFile)
}

// loadCertPair loads a TLS certificate and key from the given file paths.
func loadCertPair(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("loading cert/key pair: %w", err)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// writePEM encodes data as a PEM block and writes it to path (mode 0600).
func writePEM(path, pemType string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck

	return pem.Encode(f, &pem.Block{Type: pemType, Bytes: data})
}

// fileExists reports whether path refers to an existing file.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// loadACME sets up an autocert.Manager for automatic Let's Encrypt certificates.
// The returned TLSResult includes an HTTPHandler that must be served on :80 for
// HTTP-01 challenge validation and HTTP→HTTPS redirect.
func loadACME(cfg config.TLSConfig) (*TLSResult, error) {
	if cfg.Domain == "" {
		return nil, fmt.Errorf("TLS mode 'acme' requires tls.domain to be set (e.g. \"chat.example.com\")")
	}

	// Validate domain is not an IP address.
	if ip := net.ParseIP(cfg.Domain); ip != nil {
		return nil, fmt.Errorf("TLS mode 'acme': domain must be a hostname, not an IP address (%s); Let's Encrypt does not issue certificates for IP addresses", cfg.Domain)
	}

	// Reject wildcard domains (HTTP-01 does not support them).
	if strings.HasPrefix(cfg.Domain, "*.") || strings.Contains(cfg.Domain, "*") {
		return nil, fmt.Errorf("TLS mode 'acme': wildcard domains (%s) are not supported with HTTP-01 challenge; use a specific hostname", cfg.Domain)
	}

	cacheDir := cfg.AcmeCacheDir
	if cacheDir == "" {
		cacheDir = "data/acme_certs"
	}
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return nil, fmt.Errorf("creating ACME cache directory %s: %w", cacheDir, err)
	}

	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		Cache:      autocert.DirCache(cacheDir),
		HostPolicy: autocert.HostWhitelist(cfg.Domain),
	}

	// HTTP handler serves ACME HTTP-01 challenges on port 80 and redirects
	// all other traffic to HTTPS.
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := "https://" + cfg.Domain + r.URL.RequestURI()
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})

	tlsCfg := m.TLSConfig()
	tlsCfg.MinVersion = tls.VersionTLS12

	return &TLSResult{
		TLSConfig:   tlsCfg,
		HTTPHandler: m.HTTPHandler(redirect),
	}, nil
}
