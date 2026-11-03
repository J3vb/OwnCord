package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

const (
	// totpKeyBytes is the required length for the AES-256 encryption key.
	totpKeyBytes = 32

	// minEncryptedHexLen is the minimum hex length of a valid nonce+ciphertext:
	// a 12-byte nonce plus at least a 16-byte GCM tag, 28 bytes, 56 hex chars.
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
// (EACCES after a permissions change, EIO, a directory at the path, a dangling
// symlink) would orphan every second factor with no way back. The
// corrupt-content branches fail closed too.
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
// environment variable that overrides it, its file name under the data
// directory, its exact byte length, and the words logs and errors use.
type keyFileSpec struct {
	env, file string
	size      int
	what      string
	// orphans names what a regenerated key would silently abandon; it is why a
	// read error refuses rather than replaces.
	orphans string
	// generated is the operator advice logged when a key is auto-generated.
	generated string
	// valid, when non-nil, is checked only on the generate branch: random bytes
	// failing it are discarded and regenerated. nil means every byte string of
	// the right length is valid. The push VAPID key uses it because a uniform
	// random 32-byte scalar can fall outside the P-256 curve order.
	valid func([]byte) bool
}

// loadOrGenerateKeyFile is the fail-closed key loader the TOTP key and the
// erasure marker key share: the environment variable, else the file, else a
// fresh key written atomically, and only on a confirmed absence.
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
		// target is missing. That is something at the path: refuse rather than
		// write a new key through it.
		if _, lstatErr := os.Lstat(keyPath); lstatErr == nil {
			return nil, fmt.Errorf("%s at %s is a symlink whose target does not exist; restore the target or remove the link", spec.file, keyPath)
		}
	default:
		return nil, fmt.Errorf("reading %s: %w (refusing to generate a replacement — that would orphan %s)", spec.file, err, spec.orphans)
	}

	key := make([]byte, spec.size)
	for {
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("generating %s: %w", spec.what, err)
		}
		if spec.valid == nil || spec.valid(key) {
			break
		}
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("creating data directory for %s: %w", spec.file, err)
	}
	if err := writeKeyFileAtomic(keyPath, []byte(hex.EncodeToString(key))); err != nil {
		return nil, err
	}
	slog.Warn("auto-generated key saved to disk", "key", spec.what, "advice", spec.generated, "path", keyPath)
	return key, nil
}

// writeKeyFileAtomic writes a key file through a sibling temp file and a rename,
// so a crash mid-write never leaves a truncated key the next start refuses
// (docs/architecture/data-lifecycle.md). The rename is atomic on every
// filesystem the server runs on. A stale temp file from an interrupted run is
// removed first rather than failing the exclusive create. Shared by the TOTP
// key and the erasure marker key.
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

// ErrTOTPSecretMalformed reports a stored TOTP secret that is not in the
// sealed format (hex nonce+ciphertext). Callers treat it as a store failure,
// never as a wrong code.
var ErrTOTPSecretMalformed = errors.New("stored TOTP secret is not sealed")

// DecryptTOTPSecret decrypts a hex-encoded AES-256-GCM ciphertext back to the
// plaintext TOTP secret. A value that is not in the sealed format, or that
// fails authentication, is an error and yields the empty string: the stored
// value is never handed back as a secret. Rows written before secrets were
// sealed are converted once at startup by SealLegacyTOTPSecret.
func DecryptTOTPSecret(key []byte, ciphertext string) (string, error) {
	if len(ciphertext) < minEncryptedHexLen {
		return "", fmt.Errorf("%w: too short", ErrTOTPSecretMalformed)
	}

	data, err := hex.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("%w: not hex", ErrTOTPSecretMalformed)
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
		return "", fmt.Errorf("%w: shorter than nonce and tag", ErrTOTPSecretMalformed)
	}

	nonce, sealed := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		// A wrong key or a damaged value, either way not something to use.
		slog.Error("TOTP secret decryption failed — check TOTP_ENCRYPTION_KEY", "error", err)
		return "", fmt.Errorf("decrypting TOTP secret: %w", err)
	}

	return string(plaintext), nil
}

// SealOutcome is what SealLegacyTOTPSecret decided about one stored value.
type SealOutcome int

const (
	// SealAlreadySealed: the value decrypts under key; leave it.
	SealAlreadySealed SealOutcome = iota
	// SealConverted: the value was an unsealed base32 secret; the returned
	// string is its sealed form.
	SealConverted
	// SealUnreadable: the value neither decrypts nor is a usable base32
	// secret. It is left as it is and logins against it report a store failure.
	SealUnreadable
)

// SealLegacyTOTPSecret classifies a stored TOTP secret and, when it is an
// unsealed base32 secret from before encryption at rest, returns its sealed
// form. Only a value that decrypts under key counts as sealed, and only a value
// GenerateTOTPCode can use counts as a legacy secret, so a damaged ciphertext
// is never wrapped and then trusted as a secret.
func SealLegacyTOTPSecret(key []byte, stored string) (string, SealOutcome, error) {
	_, err := DecryptTOTPSecret(key, stored)
	if err == nil {
		return stored, SealAlreadySealed, nil
	}
	if !errors.Is(err, ErrTOTPSecretMalformed) || !usableBase32Secret(stored) {
		return stored, SealUnreadable, nil
	}
	sealed, err := EncryptTOTPSecret(key, stored)
	if err != nil {
		return stored, SealUnreadable, fmt.Errorf("sealing a legacy TOTP secret: %w", err)
	}
	return sealed, SealConverted, nil
}

// usableBase32Secret reports whether GenerateTOTPCode can derive codes from
// secret: after the same normalisation it applies, it decodes as unpadded
// base32 to at least 10 bytes (80 bits, the RFC 4226 minimum).
func usableBase32Secret(secret string) bool {
	normalised := strings.ToUpper(strings.TrimSpace(secret))
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normalised)
	return err == nil && len(decoded) >= 10
}
