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
	"os"
	"time"

	"github.com/owncord/server/config"
)

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

// LoadOrGenerate returns a *tls.Config based on the TLS configuration mode:
//   - "self_signed": loads existing cert/key or generates new ones
//   - "manual": loads existing cert/key from CertFile/KeyFile paths
//   - "off": returns nil (TLS disabled)
//   - "acme": not yet implemented — returns error
func LoadOrGenerate(cfg config.TLSConfig) (*tls.Config, error) {
	switch cfg.Mode {
	case "off":
		return nil, nil

	case "self_signed":
		return loadOrGenerateSelfSigned(cfg)

	case "manual":
		return loadCertPair(cfg.CertFile, cfg.KeyFile)

	case "acme":
		return nil, fmt.Errorf("TLS mode 'acme' is not yet implemented")

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
	defer f.Close()

	return pem.Encode(f, &pem.Block{Type: pemType, Bytes: data})
}

// fileExists reports whether path refers to an existing file.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
