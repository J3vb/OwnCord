package auth_test

import (
	"bytes"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// testKey returns a deterministic 32-byte AES-256 key.
func testKey(fill byte) []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = fill
	}
	return key
}

// TestEncryptDecryptTOTPSecret_RoundTrip pins the real AES-GCM path: a secret
// encrypted with a key must decrypt back to itself byte-for-byte, and the
// stored form must not be the plaintext.
func TestEncryptDecryptTOTPSecret_RoundTrip(t *testing.T) {
	key := testKey(0x2a)
	secrets := []string{
		"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", // 32-char base32 TOTP secret
		"JBSWY3DPEHPK3PXP",                 // 16-char legacy-length secret
		"",                                 // empty plaintext still round-trips
	}

	for _, secret := range secrets {
		encrypted, err := auth.EncryptTOTPSecret(key, secret)
		if err != nil {
			t.Fatalf("EncryptTOTPSecret(%q): %v", secret, err)
		}
		if encrypted == secret {
			t.Fatalf("EncryptTOTPSecret(%q) returned the plaintext", secret)
		}

		got, err := auth.DecryptTOTPSecret(key, encrypted)
		if err != nil {
			t.Fatalf("DecryptTOTPSecret(%q): %v", secret, err)
		}
		if got != secret {
			t.Fatalf("round-trip = %q, want %q", got, secret)
		}
	}
}

// TestEncryptTOTPSecret_NonceIsRandom pins that two encryptions of the same
// secret differ, so a stored ciphertext cannot be used as a secret fingerprint.
func TestEncryptTOTPSecret_NonceIsRandom(t *testing.T) {
	key := testKey(0x11)
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

	first, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	second, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	if first == second {
		t.Fatal("two encryptions of the same secret produced identical ciphertext (nonce reuse)")
	}
}

// TestDecryptTOTPSecret_FailsClosed pins the documented invariant at
// totp_encrypt.go: a value that has the full encrypted shape (valid hex, long
// enough for nonce+tag) but fails GCM authentication must return an error and
// an EMPTY string. Returning the ciphertext would silently mask a wrong
// OWNCORD_TOTP_KEY and hand the caller a bogus "secret".
func TestDecryptTOTPSecret_FailsClosed(t *testing.T) {
	key := testKey(0x01)
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

	encrypted, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}

	// Flip the last ciphertext byte to simulate tampering/corruption.
	raw, err := hex.DecodeString(encrypted)
	if err != nil {
		t.Fatalf("hex.DecodeString: %v", err)
	}
	raw[len(raw)-1] ^= 0xff
	tampered := hex.EncodeToString(raw)

	tests := []struct {
		name       string
		key        []byte
		ciphertext string
	}{
		{name: "wrong key", key: testKey(0x02), ciphertext: encrypted},
		{name: "tampered ciphertext", key: key, ciphertext: tampered},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := auth.DecryptTOTPSecret(tc.key, tc.ciphertext)
			if err == nil {
				t.Fatalf("DecryptTOTPSecret returned nil error (got %q); must fail closed", got)
			}
			if got != "" {
				t.Fatalf("DecryptTOTPSecret returned %q on auth failure; must return the empty string, never the ciphertext", got)
			}
		})
	}
}

// TestDecryptTOTPSecret_UnsealedValueIsAnError pins strict decrypt: a value
// that is not in the sealed format is reported as ErrTOTPSecretMalformed with
// an empty result, never handed back as the secret.
func TestDecryptTOTPSecret_UnsealedValueIsAnError(t *testing.T) {
	key := testKey(0x03)
	tests := []struct {
		name  string
		value string
	}{
		{name: "short base32 secret", value: "JBSWY3DPEHPK3PXP"},
		{name: "empty value", value: ""},
		// Long enough for the sealed format but not valid hex.
		{name: "long non-hex value", value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBV"},
		{name: "odd-length hex", value: strings.Repeat("a", 57)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := auth.DecryptTOTPSecret(key, tc.value)
			if !errors.Is(err, auth.ErrTOTPSecretMalformed) {
				t.Fatalf("DecryptTOTPSecret(%q) error = %v, want ErrTOTPSecretMalformed", tc.value, err)
			}
			if got != "" {
				t.Fatalf("DecryptTOTPSecret(%q) = %q, want the empty string", tc.value, got)
			}
		})
	}
}

// TestSealLegacyTOTPSecret pins the startup conversion's classification: a
// sealed value is left alone, an unsealed base32 secret is sealed and decrypts
// back to itself, and anything else (a damaged ciphertext, a value no code can
// be derived from) is reported unreadable and returned unchanged.
func TestSealLegacyTOTPSecret(t *testing.T) {
	key := testKey(0x04)
	const legacy = "JBSWY3DPEHPK3PXP"
	sealed, err := auth.EncryptTOTPSecret(key, legacy)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	underOtherKey, err := auth.EncryptTOTPSecret(testKey(0x05), legacy)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}

	t.Run("legacy base32 is sealed", func(t *testing.T) {
		for _, v := range []string{legacy, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "jbswy3dpehpk3pxp", " JBSWY3DPEHPK3PXP "} {
			got, outcome, err := auth.SealLegacyTOTPSecret(key, v)
			if err != nil || outcome != auth.SealConverted {
				t.Fatalf("SealLegacyTOTPSecret(%q) = %v, %v, want SealConverted", v, outcome, err)
			}
			back, err := auth.DecryptTOTPSecret(key, got)
			if err != nil || back != v {
				t.Fatalf("sealed form of %q decrypts to %q, %v", v, back, err)
			}
			code, err := auth.GenerateTOTPCode(back, time.Unix(1_700_000_000, 0))
			want, _ := auth.GenerateTOTPCode(v, time.Unix(1_700_000_000, 0))
			if err != nil || code != want {
				t.Fatalf("code from the sealed form = %q, %v, want %q", code, err, want)
			}
		}
	})

	t.Run("sealed value is left alone", func(t *testing.T) {
		got, outcome, err := auth.SealLegacyTOTPSecret(key, sealed)
		if err != nil || outcome != auth.SealAlreadySealed || got != sealed {
			t.Fatalf("SealLegacyTOTPSecret(sealed) = %q, %v, %v, want it unchanged", got, outcome, err)
		}
	})

	for _, tc := range []struct{ name, value string }{
		{"sealed under another key", underOtherKey},
		{"empty", ""},
		{"not base32", "not a secret!"},
		{"too few bits", "JBSWY3DP"},
		{"long non-hex non-base32", strings.Repeat("Z1", 30)},
		{"truncated lower-case hex", "abcdef234567abcdef234567abcdef23"},
	} {
		t.Run(tc.name+" is unreadable", func(t *testing.T) {
			got, outcome, err := auth.SealLegacyTOTPSecret(key, tc.value)
			if err != nil || outcome != auth.SealUnreadable || got != tc.value {
				t.Fatalf("SealLegacyTOTPSecret(%q) = %q, %v, %v, want it unchanged and unreadable", tc.value, got, outcome, err)
			}
		})
	}
}

// TestLoadOrGenerateTOTPKey_StableAcrossRestarts pins that the second boot
// reads totp.key back off disk instead of generating a fresh key. A regression
// here makes every stored (encrypted) TOTP secret undecryptable after a
// restart, locking every 2FA account out.
func TestLoadOrGenerateTOTPKey_StableAcrossRestarts(t *testing.T) {
	t.Setenv("OWNCORD_TOTP_KEY", "")
	dataDir := filepath.Join(t.TempDir(), "data")

	first, err := auth.LoadOrGenerateTOTPKey(dataDir)
	if err != nil {
		t.Fatalf("first LoadOrGenerateTOTPKey: %v", err)
	}
	if len(first) != 32 {
		t.Fatalf("key length = %d, want 32", len(first))
	}

	second, err := auth.LoadOrGenerateTOTPKey(dataDir)
	if err != nil {
		t.Fatalf("second LoadOrGenerateTOTPKey: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("key changed across restarts: %x then %x", first, second)
	}

	// The persisted key must be the one returned, so an operator copying
	// totp.key to another host gets the same decryption key.
	onDisk, err := os.ReadFile(filepath.Join(dataDir, "totp.key"))
	if err != nil {
		t.Fatalf("reading totp.key: %v", err)
	}
	if string(onDisk) != hex.EncodeToString(first) {
		t.Fatalf("totp.key = %q, want %q", onDisk, hex.EncodeToString(first))
	}
}

// TestLoadOrGenerateTOTPKey_EnvVar pins that OWNCORD_TOTP_KEY wins over a
// totp.key on disk (so an operator can rotate without touching the file) and
// that a wrong-length env key is a hard error rather than a silent fallback to
// auto-generation.
func TestLoadOrGenerateTOTPKey_EnvVar(t *testing.T) {
	t.Run("valid hex wins over the key file", func(t *testing.T) {
		envKey := testKey(0x7e)
		t.Setenv("OWNCORD_TOTP_KEY", hex.EncodeToString(envKey))
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "totp.key"),
			[]byte(hex.EncodeToString(testKey(0x01))), 0o600); err != nil {
			t.Fatalf("writing totp.key: %v", err)
		}

		got, err := auth.LoadOrGenerateTOTPKey(dataDir)
		if err != nil {
			t.Fatalf("LoadOrGenerateTOTPKey: %v", err)
		}
		if !bytes.Equal(got, envKey) {
			t.Fatalf("key = %x, want the env key %x", got, envKey)
		}
	})

	t.Run("wrong length is a hard error", func(t *testing.T) {
		t.Setenv("OWNCORD_TOTP_KEY", hex.EncodeToString(make([]byte, 16)))
		key, err := auth.LoadOrGenerateTOTPKey(t.TempDir())
		if err == nil {
			t.Fatalf("LoadOrGenerateTOTPKey accepted a 16-byte OWNCORD_TOTP_KEY (returned %x)", key)
		}
		if key != nil {
			t.Fatalf("LoadOrGenerateTOTPKey returned key %x alongside an error; want nil", key)
		}
	})
}

// TestLoadOrGenerateTOTPKey_RejectsBadKeyFile pins that a corrupt totp.key is a
// hard error rather than a silent regeneration (which would orphan every
// stored secret).
func TestLoadOrGenerateTOTPKey_RejectsBadKeyFile(t *testing.T) {
	tests := []struct {
		name     string
		contents string
	}{
		{name: "invalid hex", contents: "not-hex-at-all"},
		{name: "wrong length", contents: hex.EncodeToString(make([]byte, 16))},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OWNCORD_TOTP_KEY", "")
			dataDir := t.TempDir()
			keyPath := filepath.Join(dataDir, "totp.key")
			if err := os.WriteFile(keyPath, []byte(tc.contents), 0o600); err != nil {
				t.Fatalf("writing totp.key: %v", err)
			}

			key, err := auth.LoadOrGenerateTOTPKey(dataDir)
			if err == nil {
				t.Fatalf("LoadOrGenerateTOTPKey accepted a corrupt totp.key (returned %x)", key)
			}
			if key != nil {
				t.Fatalf("LoadOrGenerateTOTPKey returned key %x alongside an error; want nil", key)
			}

			// The corrupt file must be left alone, not overwritten with a
			// freshly generated key.
			after, readErr := os.ReadFile(keyPath)
			if readErr != nil {
				t.Fatalf("reading totp.key after failure: %v", readErr)
			}
			if string(after) != tc.contents {
				t.Fatalf("totp.key was rewritten to %q, want %q", after, tc.contents)
			}
		})
	}
}
