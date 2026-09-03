package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
)

const (
	// totpKeyBytes is the required length for the AES-256 encryption key.
	totpKeyBytes = 32

	// minEncryptedHexLen is the minimum hex-encoded length of a valid
	// nonce+ciphertext (12-byte nonce + at least 16-byte GCM tag = 28 bytes
	// = 56 hex chars).
	minEncryptedHexLen = 56
)

// LoadOrGenerateTOTPKey returns a 32-byte AES-256 key for TOTP secret
// encryption. It checks (in order):
//  1. OWNCORD_TOTP_KEY environment variable (hex-encoded 32 bytes)
//  2. dataDir/totp.key file
//  3. Auto-generates a random key, writes it to dataDir/totp.key, and logs a warning
//
// Only a confirmed absence may fall through to generation: every stored TOTP
// secret is ciphertext under this key, so replacing the file on a read error
// (EACCES after a permissions change, EIO, a directory at the path, a
// dangling symlink) would orphan every second factor on the server with no
// way back (OC-0321). The corrupt-content branches fail closed too.
func LoadOrGenerateTOTPKey(dataDir string) ([]byte, error) {
	return loadOrGenerateKeyFile(keyFileSpec{
		env:       "OWNCORD_TOTP_KEY",
		file:      "totp.key",
		size:      totpKeyBytes,
		what:      "TOTP encryption key",
		orphans:   "every stored TOTP secret",
		generated: "set OWNCORD_TOTP_KEY env var for production deployments",
	}, dataDir)
}

// keyFileSpec describes one key the server keeps beside its data: the
// environment variable that overrides it, the file name under the data
// directory, the exact byte length, and the words the logs and errors use.
type keyFileSpec struct {
	env, file string
	size      int
	what      string
	// orphans names what a regenerated key would silently abandon; it is
	// why a read error refuses rather than replaces.
	orphans string
	// generated is the operator advice logged when a key is auto-generated.
	generated string
}

// loadOrGenerateKeyFile is the fail-closed key loader the TOTP key and the
// erasure marker key (B4-10) share: the environment variable, else the file,
// else a fresh key written atomically — and only on a confirmed absence.
func loadOrGenerateKeyFile(spec keyFileSpec, dataDir string) ([]byte, error) {
	if envKey := os.Getenv(spec.env); envKey != "" {
		key, err := hex.DecodeString(envKey)
		if err != nil {
			return nil, fmt.Errorf("%s is not valid hex: %w", spec.env, err)
		}
		if len(key) != spec.size {
			return nil, fmt.Errorf("%s must be exactly %d bytes (got %d)", spec.env, spec.size, len(key))
		}
		slog.Info("loaded " + spec.what + " from " + spec.env + " environment variable")
		return key, nil
	}

	keyPath := filepath.Join(dataDir, spec.file)
	data, err := os.ReadFile(keyPath) //nolint:gosec // G304: the path is dataDir/<key file>, not input
	switch {
	case err == nil:
		key, decErr := hex.DecodeString(string(data))
		if decErr != nil {
			return nil, fmt.Errorf("%s contains invalid hex: %w", spec.file, decErr)
		}
		if len(key) != spec.size {
			return nil, fmt.Errorf("%s must contain exactly %d bytes (got %d)", spec.file, spec.size, len(key))
		}
		slog.Info("loaded "+spec.what+" from file", "path", keyPath)
		return key, nil
	case errors.Is(err, fs.ErrNotExist):
		// ReadFile follows symlinks, so ENOENT also describes a symlink whose
		// target is missing. That is something at the path, not nothing:
		// refuse rather than write a new key through it.
		if _, lstatErr := os.Lstat(keyPath); lstatErr == nil {
			return nil, fmt.Errorf("%s at %s is a symlink whose target does not exist; restore the target or remove the link", spec.file, keyPath)
		}
	default:
		return nil, fmt.Errorf("reading %s: %w (refusing to generate a replacement — that would orphan %s)", spec.file, err, spec.orphans)
	}

	key := make([]byte, spec.size)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generating %s: %w", spec.what, err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("creating data directory for %s: %w", spec.file, err)
	}
	if err := writeKeyFileAtomic(keyPath, []byte(hex.EncodeToString(key))); err != nil {
		return nil, err
	}
	slog.Warn("auto-generated "+spec.what+" and saved to disk; "+spec.generated, "path", keyPath)
	return key, nil
}

// writeKeyFileAtomic writes a key file through a sibling temp file and a
// rename, so a crash mid-write can never leave a truncated key that the
// next start refuses (docs/architecture/data-lifecycle.md, O7 A1). The
// rename is the only step that makes the key visible, and it is atomic on
// every filesystem the server runs on. A stale temp file from an earlier
// interrupted run is removed first rather than failing the exclusive create.
// Shared by the TOTP key and the erasure marker key (B4-10).
func writeKeyFileAtomic(keyPath string, contents []byte) error {
	name := filepath.Base(keyPath)
	tmpPath := keyPath + ".tmp"
	_ = os.Remove(tmpPath)
	tmp, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // G304: the path is dataDir/<key>.tmp, not input
	if err != nil {
		return fmt.Errorf("creating %s temp file: %w", name, err)
	}
	if _, err := tmp.Write(contents); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("writing %s temp file: %w", name, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("syncing %s temp file: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("closing %s temp file: %w", name, err)
	}
	if err := os.Rename(tmpPath, keyPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("writing %s: %w", name, err)
	}
	return nil
}

// EncryptTOTPSecret encrypts a plaintext TOTP secret using AES-256-GCM.
// Returns a hex-encoded string of nonce+ciphertext.
func EncryptTOTPSecret(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generating nonce: %w", err)
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(ciphertext), nil
}

// DecryptTOTPSecret decrypts a hex-encoded AES-256-GCM ciphertext back to the
// plaintext TOTP secret. For backwards compatibility, if the value does not
// look like valid encrypted data (not valid hex, or too short for
// nonce+tag), it is returned as-is so that existing unencrypted secrets
// continue to work.
func DecryptTOTPSecret(key []byte, ciphertext string) (string, error) {
	// Backwards compatibility: if it doesn't look encrypted, return as-is.
	// M-4: Log a warning so operators can detect unencrypted TOTP secrets
	// and migrate them (e.g. after key rotation or initial setup).
	if len(ciphertext) < minEncryptedHexLen {
		slog.Warn("TOTP secret returned as plaintext (too short for encrypted format) — consider encrypting legacy secrets")
		return ciphertext, nil
	}

	data, err := hex.DecodeString(ciphertext)
	if err != nil {
		// Not valid hex -- treat as unencrypted plaintext (backwards compat).
		slog.Warn("TOTP secret returned as plaintext (not valid hex) — consider encrypting legacy secrets")
		return ciphertext, nil //nolint:nilerr
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize+gcm.Overhead() {
		// Too short to be valid encrypted data -- return as plaintext.
		slog.Warn("TOTP secret returned as plaintext (data too short for nonce+tag)")
		return ciphertext, nil
	}

	nonce, sealed := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		// The value has the full encrypted shape (valid hex, long enough for
		// nonce+tag) but GCM authentication failed. That is a real error — a
		// wrong TOTP_ENCRYPTION_KEY or a tampered/corrupted ciphertext — not a
		// legacy plaintext secret (those are caught by the not-hex and
		// too-short branches above). Fail CLOSED: returning the ciphertext as
		// if it were the secret would silently mask key misconfiguration.
		slog.Error("TOTP secret decryption failed — check TOTP_ENCRYPTION_KEY", "error", err)
		return "", fmt.Errorf("decrypting TOTP secret: %w", err)
	}

	return string(plaintext), nil
}
