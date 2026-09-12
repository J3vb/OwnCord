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
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/J3vb/OwnCord/Server/config"
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
		// The limit is this client, not the CA. Let's Encrypt has issued
		// certificates for IP addresses since 2026-01-15, under a
		// short-lived profile that golang.org/x/crypto/acme/autocert cannot
		// request: its Manager accepts hostnames only and has no profile
		// selection. Naming the CA sent owners to check the wrong thing.
		// A public-IP certificate flow is B6-3, which is deferred.
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

	// HTTP handler serves ACME HTTP-01 challenges on port 80 and redirects
	// all other traffic to HTTPS. The HTTPS listener does not necessarily
	// bind 443 (the default is 8443), so the redirect must name the
	// configured port explicitly.
	host := cfg.Domain
	if cfg.HTTPSPort != 0 && cfg.HTTPSPort != 443 {
		host = net.JoinHostPort(cfg.Domain, strconv.Itoa(cfg.HTTPSPort))
	}
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := "https://" + host + r.URL.RequestURI()
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})

	tlsCfg := m.TLSConfig()
	tlsCfg.MinVersion = tls.VersionTLS12
	tlsCfg.GetCertificate = logCertificateFailures(tlsCfg.GetCertificate, cfg.Domain)

	return &TLSResult{
		TLSConfig:   tlsCfg,
		HTTPHandler: m.HTTPHandler(redirect),
	}, nil
}

// certFailureLogInterval bounds how often an issuance failure is logged. Long
// enough that a client retrying in a loop cannot flood the log, short enough
// that an operator watching the log while they fix their port forwarding sees
// the state change.
const certFailureLogInterval = 10 * time.Minute

// logCertificateFailures reports certificate-issuance failures, at most once
// per certFailureLogInterval.
//
// Without it these failures are invisible. internal/app sets the HTTP server's
// ErrorLog to io.Discard — deliberately, to suppress per-handshake TLS noise,
// and that comment is right — which also discarded the one error an operator
// needs: a server whose port 80 cannot be reached from the internet logs
// "server starting", reports healthy, and then fails every TLS handshake in
// silence. B6-6 exists to stop a reachability limit reading as application
// success, and this is the clearest instance of it in the tree.
//
// It observes and returns the underlying error unchanged, so autocert's own
// retry and caching are untouched.
//
// Two things it deliberately does not do, because this runs on an
// unauthenticated path — every ClientHello reaches it, before any handshake
// completes:
//
//   - It keeps no per-name state. Deduplicating by hello.ServerName would let
//     an unauthenticated peer grow a map without bound by varying SNI, so the
//     throttle is a single timestamp instead.
//   - It never logs hello.ServerName. That field is whatever the peer sent;
//     the operator already knows which domain they configured, so the log
//     carries that instead and no attacker-supplied bytes reach it.
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
