package app

import (
	"bytes"
	"crypto/tls"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	yaml "go.yaml.in/yaml/v3"

	"github.com/J3vb/OwnCord/Server/config"
)

// RunHealthcheckCLI probes the local server's /health endpoint and returns a
// process exit code: 0 healthy, 1 degraded or unreachable. /health answers
// 503 with a subsystem reason when the hub, database, or disk is unhealthy,
// so a container orchestrator's healthcheck surfaces those too.
func RunHealthcheckCLI() int {
	p := resolveHealthcheckProbe(config.DefaultPath)
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: healthcheckTLSConfig(p.tlsMode, p.certFile, p.acmeDomain),
		},
	}
	resp, err := client.Get(fmt.Sprintf("%s://127.0.0.1:%d/health", p.scheme, p.port)) //nolint:gosec // G704: host is hardcoded loopback; only the port comes from the operator's own config
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck: unreachable:", err)
		return 1
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fmt.Fprintf(os.Stderr, "healthcheck: status %d: %s\n", resp.StatusCode, body)
		return 1
	}
	return 0
}

// healthcheckProbe is the address and TLS identity the probe dials.
type healthcheckProbe struct {
	port       int
	scheme     string
	certFile   string
	tlsMode    string
	acmeDomain string
}

// resolveHealthcheckProbe reads the values that shape the probe: config.yaml,
// then the panel's overrides file (on the data dir from the file or the
// environment), then the OWNCORD_* environment. It is deliberately NOT
// config.Load, which writes a default config.yaml when none exists; a probe
// must have no side effects, so it peeks at the file and reuses
// config.ReadOverrides rather than building a whole config.
func resolveHealthcheckProbe(cfgPath string) healthcheckProbe {
	p := healthcheckProbe{port: 8443, scheme: "https", certFile: "data/cert.pem"}
	dataDir := "data"
	if raw, err := os.ReadFile(cfgPath); err == nil {
		var partial struct {
			Server struct {
				Port    int    `yaml:"port"`
				DataDir string `yaml:"data_dir"`
			} `yaml:"server"`
			TLS struct {
				Mode     string `yaml:"mode"`
				CertFile string `yaml:"cert_file"`
				Domain   string `yaml:"domain"`
			} `yaml:"tls"`
		}
		if yaml.Unmarshal(raw, &partial) == nil {
			if partial.Server.Port > 0 {
				p.port = partial.Server.Port
			}
			if partial.Server.DataDir != "" {
				dataDir = partial.Server.DataDir
			}
			p.tlsMode = partial.TLS.Mode
			if partial.TLS.CertFile != "" {
				p.certFile = partial.TLS.CertFile
			}
			p.acmeDomain = partial.TLS.Domain
		}
	}
	if env := os.Getenv("OWNCORD_SERVER_DATA_DIR"); env != "" {
		dataDir = env
	}
	if overrides, err := config.ReadOverrides(config.OverridesPath(dataDir)); err == nil {
		applyHealthcheckOverrides(&p, overrides)
	}
	if env := os.Getenv("OWNCORD_SERVER_PORT"); env != "" {
		if n, err := strconv.Atoi(env); err == nil && n > 0 {
			p.port = n
		}
	}
	if env := os.Getenv("OWNCORD_TLS_MODE"); env != "" {
		p.tlsMode = env
	}
	if env := os.Getenv("OWNCORD_TLS_CERT_FILE"); env != "" {
		p.certFile = env
	}
	if env := os.Getenv("OWNCORD_TLS_DOMAIN"); env != "" {
		p.acmeDomain = env
	}
	if p.port < 1 || p.port > 65535 {
		p.port = 8443
	}
	if p.tlsMode == "off" {
		p.scheme = "http"
	}
	return p
}

// applyHealthcheckOverrides copies the four probe-shaping keys a panel override
// may hold. config.ReadOverrides has already normalised and validated them.
func applyHealthcheckOverrides(p *healthcheckProbe, overrides map[string]any) {
	if v, ok := overrides["server.port"].(int); ok && v > 0 {
		p.port = v
	}
	if v, ok := overrides["tls.mode"].(string); ok {
		p.tlsMode = v
	}
	if v, ok := overrides["tls.cert_file"].(string); ok && v != "" {
		p.certFile = v
	}
	if v, ok := overrides["tls.domain"].(string); ok {
		p.acmeDomain = v
	}
}

// healthcheckTLSConfig builds the probe's TLS config, per TLS mode:
//
//   - acme: the served cert is CA-issued for the configured domain, so
//     standard WebPKI verification works — but the probe dials 127.0.0.1, so
//     ServerName must be overridden to the domain or hostname verification
//     fails unconditionally and the probe reports a healthy server as down.
//     A stale pre-ACME data/cert.pem must NOT be pinned in this mode either;
//     the pin would mismatch the served ACME leaf forever.
//   - self_signed / manual: the cert can never pass WebPKI (the generated one
//     has no SANs and IsCA=false), so hostname/chain checks are replaced (not
//     skipped) by pinning: the presented leaf must be byte-identical to the
//     local cert file.
//   - anything else with no readable local cert: plain WebPKI.
func healthcheckTLSConfig(tlsMode, certFile, acmeDomain string) *tls.Config {
	if tlsMode == "acme" && acmeDomain != "" {
		return &tls.Config{MinVersion: tls.VersionTLS12, ServerName: acmeDomain}
	}
	pinned := loadPinnedCert(certFile)
	if pinned == nil {
		return &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Chain/hostname verification is replaced by the exact-match pin
		// below, which is strictly stronger for a cert we hold on disk.
		// VerifyConnection (not VerifyPeerCertificate) so the pin also runs
		// on resumed sessions (gosec G123).
		InsecureSkipVerify: true, //nolint:gosec // G402: VerifyConnection below pins the exact local certificate
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("healthcheck: server presented no certificate")
			}
			if !bytes.Equal(cs.PeerCertificates[0].Raw, pinned) {
				return errors.New("healthcheck: server certificate does not match " + certFile)
			}
			return nil
		},
	}
}

// loadPinnedCert reads the first PEM certificate block from path, returning
// its DER bytes, or nil when unavailable.
func loadPinnedCert(path string) []byte {
	raw, err := os.ReadFile(path) //nolint:gosec // G304: path is the operator's own configured cert file
	if err != nil {
		return nil
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil
	}
	return block.Bytes
}
