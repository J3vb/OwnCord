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

// TLSResult holds the output of LoadOrGenerate. Usually only TLSConfig is set;
// in ACME mode HTTPHandler is also set and must be served on :80 for HTTP-01
// challenges and the redirect.
type TLSResult struct {
	TLSConfig   *tls.Config
	HTTPHandler http.Handler // non-nil only for ACME mode
	// Fingerprint is the SHA-256 of the served leaf certificate in the
	// lower-case colon-hex form the desktop client shows and pins
	// (Client/src-tauri/src/tofu.rs). Empty for TLS off and for ACME before the
	// first handshake, where the leaf is not known at start-up.
	Fingerprint string
	// Served tracks the leaf certificate being served now: set at load for
	// self_signed and manual, and on every handshake for ACME, so a renewal
	// shows without a restart. Nil for TLS off (a reverse proxy serves the
	// certificate); a nil tracker reports the zero ServedCert.
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

// Current returns the most recently served certificate, or the zero value before
// the first one or on a nil tracker.
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

// GenerateSelfSigned generates an ECDSA P-256 self-signed TLS certificate valid
// for 2 years and writes the PEM-encoded cert and key to the given paths. P-256
// gives equivalent security to RSA 4096 at a fraction of the key generation
// cost, which matters for server startup and test speed.
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

// certConfigFingerprint is the leaf fingerprint of a config with a statically
// loaded certificate, or "" when it has none (ACME's is fetched on the first
// handshake, so it cannot be printed at start-up).
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

// loadACME sets up an autocert.Manager for automatic Let's Encrypt certificates.
// The TLSResult's HTTPHandler must be served on :80 for HTTP-01 validation and
// the HTTP→HTTPS redirect.
func loadACME(cfg config.TLSConfig) (*TLSResult, error) {
	if cfg.Domain == "" {
		return nil, fmt.Errorf("TLS mode 'acme' requires tls.domain to be set (e.g. \"chat.example.com\")")
	}

	// Reject an IP address as domain.
	if ip := net.ParseIP(cfg.Domain); ip != nil {
		// The limit is this client, not the CA: Let's Encrypt issues IP
		// certificates under a short-lived profile that
		// golang.org/x/crypto/acme/autocert cannot request (hostnames only, no
		// profile selection). Naming the CA sent owners to check the wrong thing.
		return nil, fmt.Errorf("TLS mode 'acme': domain must be a hostname, not an IP address (%s); "+
			"this build's ACME client cannot request a certificate for an IP address. Use a hostname, "+
			"or set tls.mode to \"manual\" with your own certificate, or stay on \"self_signed\" and "+
			"trust it on each client", cfg.Domain)
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

	// The HTTP handler serves ACME HTTP-01 challenges on port 80 and redirects
	// everything else to HTTPS. The HTTPS listener need not bind 443 (default
	// 8443), so the redirect names the configured port.
	host := cfg.Domain
	if cfg.HTTPSPort != 0 && cfg.HTTPSPort != 443 {
		host = net.JoinHostPort(cfg.Domain, strconv.Itoa(cfg.HTTPSPort))
	}
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Compose through url.URL, not concatenation: the request URI becomes
		// Path/RawQuery on a URL whose Scheme and Host are fixed here, so a
		// crafted path can never move the redirect to another host.
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

// trackServed records each certificate next hands to a member's handshake. A
// TLS-ALPN-01 validation handshake gets a throwaway challenge certificate, so
// it is skipped; so is autocert's RSA leaf, which goes only to clients that
// cannot use ECDSA.
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

// certFailureLogInterval bounds how often an issuance failure is logged: long
// enough that a client retrying in a loop cannot flood the log, short enough
// that an operator fixing their port forwarding sees the state change.
const certFailureLogInterval = 10 * time.Minute

// logCertificateFailures reports certificate-issuance failures, at most once per
// certFailureLogInterval.
//
// Without it these failures are invisible: internal/app sets the HTTP server's
// ErrorLog to io.Discard to suppress per-handshake TLS noise, which also
// discarded the one error an operator needs. A server whose port 80 is
// unreachable from the internet would log "server starting", report healthy,
// and fail every TLS handshake in silence, the reachability-read-as-success
// case the connectivity check exists to stop.
//
// It observes and returns the underlying error unchanged, so autocert's retry
// and caching are untouched.
//
// It deliberately does two things on this unauthenticated path (every
// ClientHello reaches it before any handshake completes):
//
//   - It keeps no per-name state. Deduplicating by hello.ServerName would let
//     an unauthenticated peer grow a map without bound by varying SNI, so the
//     throttle is a single timestamp.
//   - It never logs hello.ServerName, which is whatever the peer sent; the log
//     carries the configured domain, so no attacker-supplied bytes reach it.
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

		// Only a hello for the configured domain says issuance is broken for
		// real clients; scanner hellos with a missing or foreign name must not
		// log or spend the throttle. hello.ServerName is compared, never logged.
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
