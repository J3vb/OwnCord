package service

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"testing"
)

// mustHex decodes a hex literal or fails the test — every constant below is
// transcribed from RFC 8291 Section 5 and Appendix A (fetched from
// https://www.rfc-editor.org/rfc/rfc8291.txt) and independently
// cross-checked against every intermediate value the RFC publishes
// (ecdh_secret, PRK_key, key_info, IKM, PRK, CEK, NONCE, the header and the
// ciphertext) using Python's `cryptography` library before being copied
// here, so a transcription slip in one constant would already have been
// caught rather than silently baked into this test.
func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("mustHex(%q): %v", s, err)
	}
	return b
}

// TestPushCrypto_RFC8291KnownAnswer reproduces RFC 8291 Section 5's worked
// example exactly: the same sender (application server) key pair and salt
// as input, the same receiver (user agent) key pair and auth secret, the
// same plaintext, and byte-for-byte the same 144-octet output (86-octet
// aes128gcm header + 58-octet ciphertext).
func TestPushCrypto_RFC8291KnownAnswer(t *testing.T) {
	asPriv := mustHex(t, "c9f58f89813e9f8e872e71f42aa64e1757c9254dcc62b72ddc010bb4043ea11c")
	uaPub := mustHex(t, "042571b2becdfde360551aaf1ed0f4cd366c11cebe555f89bcb7b186a53339173168ece2ebe018597bd30479b86e3c8f8eced577ca59187e9246990db682008b0e")
	authSecret := mustHex(t, "05305932a1c7eabe13b6cec9fda48882")
	var salt [16]byte
	copy(salt[:], mustHex(t, "0c6bfaadad67958803092d454676f397"))
	plaintext := mustHex(t, "5768656e20492067726f772075702c20492077616e7420746f20626520612077617465726d656c6f6e")
	want := mustHex(t, "0c6bfaadad67958803092d454676f397000010004104fe33f4ab0dea71914db55823f73b54948f41306d920732dbb9a59a53286482200e597a7b7bc260ba1c227998580992e93973002f3012a28ae8f06bbb78e5ec0ff297de5b429bba7153d3a4ae0caa091fd425f3b4b5414add8ab37a19c1bbb05cf5cb5b2a2e0562d558635641ec52812c6c8ff42e95ccb86be7cd")

	ephemeral, err := ecdh.P256().NewPrivateKey(asPriv)
	if err != nil {
		t.Fatalf("NewPrivateKey(as_private): %v", err)
	}

	got, err := encryptWebPush(plaintext, uaPub, authSecret, ephemeral, salt)
	if err != nil {
		t.Fatalf("encryptWebPush: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("encryptWebPush =\n  %x\nwant\n  %x", got, want)
	}
}

// TestPushCrypto_SaltAndEphemeralKeyAreFresh is the revert-proof for the
// known-answer test above: a fixed salt and ephemeral key would still pass
// TestPushCrypto_RFC8291KnownAnswer (it asks encryptWebPush for exactly
// that), so this test pins the production path (encryptWebPushMessage)
// separately — two calls against the same receiver must carry two different
// salts and two different ephemeral public keys in their headers. Reusing
// either would reuse the derived AES-GCM key and nonce, breaking
// confidentiality for both messages.
func TestPushCrypto_SaltAndEphemeralKeyAreFresh(t *testing.T) {
	receiver, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating receiver key: %v", err)
	}
	receiverPub := receiver.PublicKey().Bytes()
	authSecret := make([]byte, 16)

	a, err := encryptWebPushMessage([]byte(`{"t":"activity"}`), receiverPub, authSecret)
	if err != nil {
		t.Fatalf("encryptWebPushMessage (1): %v", err)
	}
	b, err := encryptWebPushMessage([]byte(`{"t":"activity"}`), receiverPub, authSecret)
	if err != nil {
		t.Fatalf("encryptWebPushMessage (2): %v", err)
	}
	// header = salt(16) || rs(4) || idlen(1) || ephemeral pub(65)
	if bytes.Equal(a[:16], b[:16]) {
		t.Error("two dispatches to the same subscriber reused the same salt")
	}
	if bytes.Equal(a[21:21+65], b[21:21+65]) {
		t.Error("two dispatches to the same subscriber reused the same ephemeral public key")
	}
}
