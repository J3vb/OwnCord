package auth_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
)

// writeExpiredPair builds a self-signed pair whose validity window is in the
// past, the same shape GenerateSelfSigned produces, so the expiry behaviour of
// the documented self_signed path is measured rather than asserted.
func writeExpiredPair(t *testing.T, dir string) (string, string) {
	t.Helper()

	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating ECDSA key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"OwnCord Server"}, CommonName: "OwnCord Self-Signed"},
		NotBefore:             time.Now().Add(-2 * time.Hour),
		NotAfter:              time.Now().Add(-1 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &privKey.PublicKey, privKey)
	if err != nil {
		t.Fatalf("creating certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(privKey)
	if err != nil {
		t.Fatalf("marshalling EC private key: %v", err)
	}

	certFile := filepath.Join(dir, "cert.pem")
	keyFile := filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0o600); err != nil {
		t.Fatalf("writing cert file: %v", err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatalf("writing key file: %v", err)
	}
	return certFile, keyFile
}

// The self_signed mode loads an expired pair as-is and serves it: expiry is
// never checked at load and never re-checked while running. A fingerprint
// (TOFU) client therefore keeps connecting past expiry; the sentence in
// docs/deployment.md's rotation procedure is written from this plus
// Client/src-tauri/src/tofu.rs, whose verify_server_cert implementations
// decide on the pinned fingerprint alone and leave the validity window unused.
func TestExpiredSelfSignedCertIsServedAsIs(t *testing.T) {
	certFile, keyFile := writeExpiredPair(t, t.TempDir())

	// LoadOrGenerate with mode self_signed and both files present takes the
	// load-if-present branch: an expired pair is loaded without complaint.
	result, err := auth.LoadOrGenerate(config.TLSConfig{Mode: "self_signed", CertFile: certFile, KeyFile: keyFile})
	if err != nil {
		t.Fatalf("LoadOrGenerate() refused an expired pair: %v", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer listener.Close()
	go func() {
		raw, aerr := listener.Accept()
		if aerr != nil {
			return
		}
		server := tls.Server(raw, result.TLSConfig)
		server.Handshake() //nolint:errcheck // test server; errors surface on the client side
	}()

	dialer := &tls.Dialer{NetDialer: &net.Dialer{}, Config: &tls.Config{InsecureSkipVerify: true}} //nolint:gosec // the test pins nothing on purpose
	conn, err := dialer.DialContext(t.Context(), listener.Addr().Network(), listener.Addr().String())
	if err != nil {
		t.Fatalf("handshake against the expired pair failed: %v", err)
	}
	defer conn.Close()

	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		t.Fatalf("expected a *tls.Conn, got %T", conn)
	}
	peerLeaf := tlsConn.ConnectionState().PeerCertificates[0]
	if peerLeaf.NotAfter.After(time.Now()) {
		t.Fatalf("expected the served certificate to be the expired pair, NotAfter=%v", peerLeaf.NotAfter)
	}
}
