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
	// totpKeyBytes is the AES-256 key length.
	totpKeyBytes = 32

	// minEncryptedHexLen is a 12-byte nonce plus a 16-byte GCM tag, in hex.
	minEncryptedHexLen = 56
)

// LoadOrGenerateTOTPKey returns the 32-byte AES-256 key for TOTP secrets from
// OWNCORD_TOTP_KEY (hex), else dataDir/totp.key, else a generated key written
// there with a warning.
//
// Only a confirmed absence may fall through to generation: replacing the file on
// a read error (EACCES, EIO, a directory, a dangling symlink) would orphan every
// stored second factor. Corrupt-content branches fail closed too.
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

// keyFileSpec describes one key kept beside the data: its override variable,
// file name, exact byte length, and the words logs and errors use.
type keyFileSpec struct {
	env, file string
	size      int
	what      string
	// orphans names what a regenerated key would abandon, which is why a read error refuses.
	orphans string
	// generated is the operator advice logged when a key is auto-generated.
	generated string
	// valid, when non-nil, is checked only on generation: failing bytes are
	// regenerated (a random 32-byte scalar can fall outside the P-256 order).
	valid func([]byte) bool
}

// loadOrGenerateKeyFile is the fail-closed key loader: the environment variable,
// else the file, else a fresh key written atomically, only on a confirmed absence.
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
		// ENOENT also describes a symlink with a missing target: refuse rather
		// than write a new key through it.
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

// writeKeyFileAtomic writes a key file through a temp file and rename, so a
// crash never leaves a truncated key the next start refuses. A stale temp file
// is removed first.
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

// EncryptTOTPSecret seals a TOTP secret with AES-256-GCM, returning hex nonce+ciphertext.
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

// ErrTOTPSecretMalformed reports a stored secret not in the sealed format;
// callers treat it as a store failure, never a wrong code.
var ErrTOTPSecretMalformed = errors.New("stored TOTP secret is not sealed")

// DecryptTOTPSecret opens a hex AES-256-GCM ciphertext. A value that is not in
// the sealed format or fails authentication is an error with an empty result:
// the stored value is never handed back as a secret.
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
		// A wrong key or a damaged value.
		slog.Error("TOTP secret decryption failed — check OWNCORD_TOTP_KEY", "error", err)
		return "", fmt.Errorf("decrypting TOTP secret: %w", err)
	}

	return string(plaintext), nil
}

// SealOutcome is what SealLegacyTOTPSecret decided about one stored value.
type SealOutcome int

const (
	// SealAlreadySealed: the value decrypts under key.
	SealAlreadySealed SealOutcome = iota
	// SealConverted: an unsealed base32 secret; the result is its sealed form.
	SealConverted
	// SealUnreadable: neither decrypts nor a usable base32 secret; left as is,
	// and logins against it report a store failure.
	SealUnreadable
)

// SealLegacyTOTPSecret classifies a stored secret and seals an unsealed legacy
// base32 one. Only a value that decrypts under key counts as sealed and only
// one GenerateTOTPCode can use counts as legacy, so a damaged ciphertext is
// never wrapped and trusted.
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
// secret: unpadded base32 of at least 10 bytes (the RFC 4226 minimum). Secrets
// are upper-case and sealed values lower-case hex, so an all-lower-hex value is
// a damaged ciphertext.
func usableBase32Secret(secret string) bool {
	if strings.Trim(secret, "0123456789abcdef") == "" {
		return false
	}
	normalised := strings.ToUpper(strings.TrimSpace(secret))
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normalised)
	return err == nil && len(decoded) >= 10
}
