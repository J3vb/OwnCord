package updater

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"aead.dev/minisign"
)

// serverUpdatePublicKeyText is the pinned public key for server update
// signatures. Keep this file in sync with the SERVER_UPDATE_SIGNING_* CI
// secrets when rotating the server updater keypair.
//
//go:embed server_update_public_key.txt
var serverUpdatePublicKeyText string

var defaultServerSignaturePublicKey = strings.TrimSpace(serverUpdatePublicKeyText)

type releaseManifest struct {
	Version string `json:"version"`
	// Asset/SHA256 bind a single artifact. Releases before the multi-OS
	// manifest bound only this pair; newer releases keep it pointing at the
	// Windows binary so already-deployed servers can still verify and update.
	Asset  string `json:"asset"`
	SHA256 string `json:"sha256"`
	// Assets binds every server artifact the release ships (one per OS).
	Assets []releaseManifestAsset `json:"assets,omitempty"`
}

// releaseManifestAsset is one artifact binding in a multi-OS release manifest.
type releaseManifestAsset struct {
	Asset  string `json:"asset"`
	SHA256 string `json:"sha256"`
}

// checksumEntryNamesForGOOS returns sha256sum line suffixes to look up in
// checksums.sha256 (matches GitHub Actions release layout).
func checksumEntryNamesForGOOS(goos string) []string {
	switch goos {
	case "windows":
		return []string{"windows/chatserver.exe", "chatserver.exe"}
	case "linux":
		return []string{"linux/chatserver-linux-amd64.tar.gz", "chatserver-linux-amd64.tar.gz"}
	default:
		return nil
	}
}

func (u *Updater) parseChecksumFileAny(data []byte, names ...string) (string, error) {
	for _, name := range names {
		hash, err := u.ParseChecksumFile(data, name)
		if err == nil {
			return hash, nil
		}
	}
	return "", fmt.Errorf("no checksum line for any of: %s", strings.Join(names, ", "))
}

// VerifyReleaseManifest checks the detached signature on the release manifest
// and ensures the manifest binds the downloaded asset to the expected version.
func (u *Updater) VerifyReleaseManifest(manifestData, signatureText []byte, expectedVersion, expectedAsset string) (releaseManifest, error) {
	if err := u.verifySignatureReader(bytes.NewReader(manifestData), signatureText, manifestAsset); err != nil {
		return releaseManifest{}, fmt.Errorf("verifying release manifest signature: %w", err)
	}

	var manifest releaseManifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		return releaseManifest{}, fmt.Errorf("parsing release manifest: %w", err)
	}
	manifest.Version = ensureVPrefix(strings.TrimSpace(manifest.Version))

	if manifest.Version == "v" {
		return releaseManifest{}, fmt.Errorf("release manifest is missing required fields")
	}
	if manifest.Version != ensureVPrefix(expectedVersion) {
		return releaseManifest{}, fmt.Errorf("release manifest version %q does not match release %q", manifest.Version, ensureVPrefix(expectedVersion))
	}

	// Candidate bindings: the per-OS assets list plus the legacy single-asset
	// pair (the only binding manifests from older releases carry).
	candidates := append([]releaseManifestAsset{}, manifest.Assets...)
	candidates = append(candidates, releaseManifestAsset{Asset: manifest.Asset, SHA256: manifest.SHA256})
	for _, c := range candidates {
		asset := strings.TrimSpace(c.Asset)
		if asset == "" || asset != expectedAsset {
			continue
		}
		sum := strings.ToLower(strings.TrimSpace(c.SHA256))
		if len(sum) != sha256.Size*2 {
			return releaseManifest{}, fmt.Errorf("release manifest checksum for %s has invalid length", asset)
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return releaseManifest{}, fmt.Errorf("release manifest checksum for %s is invalid: %w", asset, err)
		}
		// Normalize the returned binding to the matched entry so callers can
		// keep reading manifest.Asset/manifest.SHA256 regardless of schema.
		manifest.Asset = asset
		manifest.SHA256 = sum
		return manifest, nil
	}
	return releaseManifest{}, fmt.Errorf("release manifest does not bind expected asset %q", expectedAsset)
}

// VerifySignature checks whether the detached minisign signature matches the
// file contents using the pinned server-update public key.
func (u *Updater) VerifySignature(filePath string, signatureText []byte) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("opening file for signature verification: %w", err)
	}
	defer f.Close() //nolint:errcheck

	return u.verifySignatureReader(f, signatureText, filepath.Base(filePath))
}

func (u *Updater) verifySignatureReader(reader io.Reader, signatureText []byte, subject string) error {
	publicKey, err := u.serverSignaturePublicKey()
	if err != nil {
		return fmt.Errorf("loading update signing key: %w", err)
	}

	verifier := minisign.NewReader(reader)
	if _, err := io.Copy(io.Discard, verifier); err != nil {
		return fmt.Errorf("reading file for signature verification: %w", err)
	}

	normalizedSig := normalizeSignatureText(signatureText)
	var parsedSig minisign.Signature
	if err := parsedSig.UnmarshalText(normalizedSig); err != nil {
		return fmt.Errorf("invalid update signature format: %w", err)
	}

	if !verifier.Verify(publicKey, normalizedSig) {
		return fmt.Errorf("signature verification failed for %s", subject)
	}
	return nil
}

// normalizeSignatureText returns the raw minisign signature document from
// signatureText. `tauri signer sign` emits .sig files that are base64-wrapped
// minisign documents (the same wrapping used for the pinned public key file);
// raw minisign documents pass through unchanged.
func normalizeSignatureText(signatureText []byte) []byte {
	trimmed := []byte(strings.TrimSpace(string(signatureText)))
	if bytes.HasPrefix(trimmed, []byte("untrusted comment:")) {
		return trimmed
	}
	if decoded, err := base64.StdEncoding.DecodeString(string(trimmed)); err == nil {
		return []byte(strings.TrimSpace(string(decoded)))
	}
	return trimmed
}

func (u *Updater) serverSignaturePublicKey() (minisign.PublicKey, error) {
	decoded, err := base64.StdEncoding.DecodeString(u.signingKeyText)
	if err != nil {
		return minisign.PublicKey{}, fmt.Errorf("decoding base64 public key: %w", err)
	}
	var publicKey minisign.PublicKey
	if err := publicKey.UnmarshalText(decoded); err != nil {
		return minisign.PublicKey{}, fmt.Errorf("parsing minisign public key: %w", err)
	}
	return publicKey, nil
}

// readerSHA256 returns the hex-encoded SHA256 of everything read from r.
func readerSHA256(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", fmt.Errorf("computing checksum: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// fileSHA256 returns the hex-encoded SHA256 of the file at path.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("opening file for checksum: %w", err)
	}
	defer f.Close() //nolint:errcheck

	return readerSHA256(f)
}

// VerifyChecksum computes the SHA256 hash of the file at filePath and
// compares it (case-insensitive) against expectedHash.
func (u *Updater) VerifyChecksum(filePath, expectedHash string) error {
	actual, err := fileSHA256(filePath)
	if err != nil {
		return err
	}
	if !strings.EqualFold(actual, expectedHash) {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedHash, actual)
	}
	return nil
}

// StagedBinary is an open handle to a staged update binary whose contents
// were verified through that same handle. Because the hash check and Commit's
// same-file check use one open file, a swap of the on-disk path between
// verification and rename is detected instead of silently executed (the
// update TOCTOU window, W3-3).
type StagedBinary struct {
	f      *os.File
	closed bool
}

// OpenVerifiedBinary opens stagedPath exactly once and verifies the SHA256 of
// its contents through that handle against expectedHash (hex,
// case-insensitive). On success the returned StagedBinary keeps the handle
// open for Commit; the caller must Close it.
func OpenVerifiedBinary(stagedPath, expectedHash string) (*StagedBinary, error) {
	f, err := os.Open(stagedPath)
	if err != nil {
		return nil, fmt.Errorf("opening staged binary: %w", err)
	}
	actual, err := readerSHA256(f)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("hashing staged binary: %w", err)
	}
	if !strings.EqualFold(actual, expectedHash) {
		_ = f.Close()
		return nil, fmt.Errorf("staged binary checksum mismatch: expected %s, got %s", expectedHash, actual)
	}
	return &StagedBinary{f: f}, nil
}

// Commit renames the staged file to destPath and confirms the file now at
// destPath is the very file the hash was verified through (os.SameFile
// against the verification handle's identity). If the staged path was swapped
// after verification, the rename moves the impostor, the same-file check
// fails, and Commit returns an error; the caller must then treat destPath as
// unverified and restore or remove it.
func (s *StagedBinary) Commit(destPath string) error {
	verified, err := s.f.Stat()
	if err != nil {
		return fmt.Errorf("stat of verified handle: %w", err)
	}
	if runtime.GOOS == "windows" {
		// Windows cannot rename a file Go holds open (os.Open does not share
		// delete) — until here that lock itself blocks swaps of the staged
		// path. The stat captured above carries the NTFS file ID, which
		// travels with the file across the rename, so the same-file check
		// below still detects a swap in the close→rename window.
		if err := s.Close(); err != nil {
			return fmt.Errorf("closing verified handle: %w", err)
		}
	}
	// On Unix the handle stays open through the rename: a held fd also pins
	// the verified inode, so its number cannot be reused by another file.
	if err := os.Rename(s.f.Name(), destPath); err != nil {
		return fmt.Errorf("renaming staged binary: %w", err)
	}
	committed, err := os.Lstat(destPath)
	if err != nil {
		return fmt.Errorf("stat of committed binary: %w", err)
	}
	if !os.SameFile(verified, committed) {
		return fmt.Errorf("staged binary was replaced after verification (refusing to run it)")
	}
	return nil
}

// Close releases the verification handle. Safe to call more than once.
func (s *StagedBinary) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.f.Close()
}

// ParseChecksumFile parses a sha256sum-format checksum file (lines of
// "<hash>  <filename>") and returns the hash for the given filename.
func (u *Updater) ParseChecksumFile(data []byte, filename string) (string, error) {
	lines := strings.SplitSeq(string(data), "\n")
	for line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// sha256sum format: "<hash>  <filename>" (two spaces)
		// Also handle single-space separation for robustness.
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[len(parts)-1] == filename {
			return parts[0], nil
		}
	}
	return "", fmt.Errorf("file %q not found in checksum data", filename)
}
