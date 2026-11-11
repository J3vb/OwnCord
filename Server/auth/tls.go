// Package auth provides authentication and TLS helpers for the OwnCord server.
package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/J3vb/OwnCord/Server/config"
)

// TLSResult holds the output of LoadOrGenerate. In ACME mode HTTPHandler is also
// set and must be served on :80 for HTTP-01 challenges and the redirect.
type TLSResult struct {
	TLSConfig   *tls.Config
	HTTPHandler http.Handler // non-nil only for ACME mode
	// Fingerprint is the SHA-256 of the served leaf in the colon-hex form the
	// desktop client pins (Client/src-tauri/src/tofu.rs). Empty for TLS off and for
	// ACME before the first handshake.
	Fingerprint string
	// Served tracks the leaf being served: set at load for self_signed and
	// manual, on every handshake for ACME, so a renewal shows without a restart.
	// Nil for TLS off.
	Served *CertTracker
}

// ServedCert is a served leaf certificate's fingerprint (LeafFingerprint's
// form) and validity period; the zero value means none is known.
type ServedCert struct {
	Fingerprint string
	NotBefore   time.Time
	NotAfter    time.Time
}

// CertTracker records the leaf certificate the server most recently served.
type CertTracker struct {
	mu  sync.Mutex
	cur ServedCert
}

// Current returns the most recently served certificate, or the zero value if none.
func (t *CertTracker) Current() ServedCert {
	if t == nil {
		return ServedCert{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cur
}

// record notes cert as served.
func (t *CertTracker) record(cert *tls.Certificate) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if cert == nil || len(cert.Certificate) == 0 {
		return
	}
	leaf := cert.Leaf
	if leaf == nil {
		parsed, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			return
		}
		leaf = parsed
	}
	t.cur = ServedCert{Fingerprint: LeafFingerprint(*cert), NotBefore: leaf.NotBefore, NotAfter: leaf.NotAfter}
}

// staticTracker is the tracker for a config with a statically loaded leaf.
func staticTracker(cfg *tls.Config) *CertTracker {
	t := &CertTracker{}
	if cfg != nil && len(cfg.Certificates) > 0 {
		t.record(&cfg.Certificates[0])
	}
	return t
}

// LeafFingerprint formats cert's leaf DER as lower-case colon-hex
// ("aa:bb:cc:..."), byte-for-byte the desktop client's pin format; "" when cert
// carries no leaf.
func LeafFingerprint(cert tls.Certificate) string {
	if len(cert.Certificate) == 0 {
		return ""
	}
	sum := sha256.Sum256(cert.Certificate[0])
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02x", b)
	}
	return strings.Join(parts, ":")
}

// GenerateSelfSigned writes an ECDSA P-256 self-signed certificate valid for 2
// years and its key, PEM-encoded, to the given paths. P-256 is much cheaper to
// generate than RSA 4096, which matters for startup and test speed.
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
		NotAfter:              now.Add(2 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
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

// LoadOrGenerate returns a *TLSResult for cfg.Mode: "self_signed" loads or
// generates a pair, "manual" loads one, "off" returns a nil TLSConfig, and
// "acme" obtains a Let's Encrypt certificate (serve HTTPHandler on :80).
func LoadOrGenerate(cfg config.TLSConfig) (*TLSResult, error) {
	switch cfg.Mode {
	case "off":
		return &TLSResult{}, nil

	case "self_signed":
		tlsCfg, err := loadOrGenerateSelfSigned(cfg)
		if err != nil {
			return nil, err
		}
		return &TLSResult{TLSConfig: tlsCfg, Fingerprint: certConfigFingerprint(tlsCfg), Served: staticTracker(tlsCfg)}, nil

	case "manual":
		tlsCfg, err := loadCertPair(cfg.CertFile, cfg.KeyFile)
		if err != nil {
			return nil, err
		}
		return &TLSResult{TLSConfig: tlsCfg, Fingerprint: certConfigFingerprint(tlsCfg), Served: staticTracker(tlsCfg)}, nil

	case "acme":
		return loadACME(cfg)

	default:
		return nil, fmt.Errorf("unknown TLS mode: %q", cfg.Mode)
	}
}

// loadOrGenerateSelfSigned loads the pair if both files exist, else generates one.
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

// loadCertPair loads a TLS certificate and key from the given files.
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

// certConfigFingerprint is the leaf fingerprint of a static certificate, or ""
// when none (ACME's is known only after the first handshake).
func certConfigFingerprint(cfg *tls.Config) string {
	if cfg == nil || len(cfg.Certificates) == 0 {
		return ""
	}
	return LeafFingerprint(cfg.Certificates[0])
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

// loadACME sets up an autocert.Manager; serve the HTTPHandler on :80 for
// HTTP-01 validation and the HTTPS redirect.
func loadACME(cfg config.TLSConfig) (*TLSResult, error) {
	if cfg.Domain == "" {
		return nil, fmt.Errorf("TLS mode 'acme' requires tls.domain to be set (e.g. \"chat.example.com\")")
	}

	if ip := net.ParseIP(cfg.Domain); ip != nil {
		// The limit is this client, not the CA: autocert cannot request the
		// short-lived profile Let's Encrypt needs for IP certificates.
		return nil, fmt.Errorf("TLS mode 'acme': domain must be a hostname, not an IP address (%s); "+
			"this build's ACME client cannot request a certificate for an IP address. Use a hostname, "+
			"or set tls.mode to \"manual\" with your own certificate, or stay on \"self_signed\" and "+
			"trust it on each client", cfg.Domain)
	}

	// HTTP-01 does not support wildcards.
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

	// The redirect names the configured port, since the HTTPS listener need not bind 443.
	host := cfg.Domain
	if cfg.HTTPSPort != 0 && cfg.HTTPSPort != 443 {
		host = net.JoinHostPort(cfg.Domain, strconv.Itoa(cfg.HTTPSPort))
	}
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Compose through url.URL so a crafted path can never move the redirect
		// to another host: Scheme and Host are fixed here.
		target := (&url.URL{
			Scheme:   "https",
			Host:     host,
			Path:     r.URL.Path,
			RawPath:  r.URL.RawPath,
			RawQuery: r.URL.RawQuery,
		}).String()
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})

	tlsCfg := m.TLSConfig()
	tlsCfg.MinVersion = tls.VersionTLS12
	served := &CertTracker{}
	tlsCfg.GetCertificate = logCertificateFailures(trackServed(tlsCfg.GetCertificate, served), cfg.Domain)

	return &TLSResult{
		TLSConfig:   tlsCfg,
		HTTPHandler: m.HTTPHandler(redirect),
		Served:      served,
	}, nil
}

// trackServed records each certificate next hands out, skipping TLS-ALPN-01
// challenge certificates and autocert's RSA leaf (for clients without ECDSA).
func trackServed(
	next func(*tls.ClientHelloInfo) (*tls.Certificate, error),
	served *CertTracker,
) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		cert, err := next(hello)
		if err == nil && cert != nil && !slices.Contains(hello.SupportedProtos, acme.ALPNProto) {
			if _, isRSA := cert.PrivateKey.(*rsa.PrivateKey); !isRSA {
				served.record(cert)
			}
		}
		return cert, err
	}
}

// certFailureLogInterval bounds how often an issuance failure is logged, so a
// retrying client cannot flood the log.
const certFailureLogInterval = 10 * time.Minute

// logCertificateFailures reports certificate-issuance failures at most once per
// certFailureLogInterval. internal/app discards the HTTP server's ErrorLog, so
// without this an unreachable port 80 fails every handshake in silence. It
// returns the underlying error unchanged, leaving autocert's retry and caching
// untouched.
//
// On this unauthenticated path (every ClientHello reaches it):
//   - It keeps no per-name state: deduplicating by hello.ServerName would let a
//     peer grow a map without bound by varying SNI, so the throttle is one timestamp.
//   - It never logs hello.ServerName; the log carries the configured domain, so
//     no attacker-supplied bytes reach it.
func logCertificateFailures(
	next func(*tls.ClientHelloInfo) (*tls.Certificate, error),
	domain string,
) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	if next == nil {
		return nil
	}
	var mu sync.Mutex
	var lastReported time.Time

	return func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		cert, err := next(hello)
		if err == nil {
			return cert, nil
		}

		// Only a hello for the configured domain says issuance is broken; scanner
		// hellos must not log or spend the throttle. hello.ServerName is compared, never logged.
		if hello == nil || !strings.EqualFold(strings.TrimSuffix(hello.ServerName, "."), domain) {
			return cert, err
		}

		mu.Lock()
		report := lastReported.IsZero() || time.Since(lastReported) >= certFailureLogInterval
		if report {
			lastReported = time.Now()
		}
		mu.Unlock()

		if report {
			slog.Error("TLS certificate issuance failed — clients cannot connect over HTTPS until this is fixed",
				"configured_domain", domain,
				"error", err,
				"likely_cause", "Let's Encrypt validates over HTTP-01, which needs inbound TCP :80 reachable "+
					"from the internet and resolving to this host. Check the DNS record, the port-forwarding "+
					"rule for :80, and any firewall in front of it — see docs/port-forwarding.md")
		}
		return cert, err
	}
}
