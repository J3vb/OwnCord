package updater

import (
	"bytes"
	"context"
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

// serverUpdatePublicKeyText is the pinned server-update public key; keep it in
// sync with the SERVER_UPDATE_SIGNING_* CI secrets when rotating.
//
//go:embed server_update_public_key.txt
var serverUpdatePublicKeyText string

var defaultServerSignaturePublicKey = strings.TrimSpace(serverUpdatePublicKeyText)

type releaseManifest struct {
	Version string `json:"version"`
	// Asset/SHA256 bind a single artifact: releases before the multi-OS manifest
	// bound only this pair, and newer ones keep it on the Windows binary so
	// deployed servers can still update.
	Asset  string `json:"asset"`
	SHA256 string `json:"sha256"`
	// Assets binds every server artifact the release ships (one per OS).
	Assets []releaseManifestAsset `json:"assets,omitempty"`
	// ProtocolEpoch is the client's wire epoch (protocol/schema.json); absent (0) up to v1.2.0-alpha.4.
	ProtocolEpoch int `json:"protocol_epoch,omitempty"`
}

// releaseManifestAsset is one artifact binding in a multi-OS release manifest.
type releaseManifestAsset struct {
	Asset  string `json:"asset"`
	SHA256 string `json:"sha256"`
}

// checksumEntryNamesForGOOS returns sha256sum line suffixes for one target,
// matched as whole pairs. The first is the "dir/name" form older releases used;
// the second is the bare filename and must equal serverDownloadAssetName's
// result, so the hash looked up is that of the file downloaded.
func checksumEntryNamesForGOOS(goos, goarch string) []string {
	switch {
	case goos == "windows" && goarch == "amd64":
		return []string{"windows/chatserver.exe", windowsServerBinary}
	case goos == "windows" && goarch == "arm64":
		return []string{"windows/chatserver-windows-arm64.exe", windowsServerArm64Binary}
	case goos == "linux" && goarch == "amd64":
		return []string{"linux/chatserver-linux-amd64.tar.gz", linuxServerArchive}
	case goos == "linux" && goarch == "arm64":
		return []string{"linux/chatserver-linux-arm64.tar.gz", linuxServerArm64Archive}
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

// VerifyReleaseManifest checks the manifest's detached signature and that it binds the asset to the expected
// version.
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

	// Candidates: the per-OS assets list plus the legacy single pair older manifests carry.
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
		// Normalize the binding so callers can read manifest.Asset/SHA256 regardless of schema.
		manifest.Asset = asset
		manifest.SHA256 = sum
		return manifest, nil
	}
	return releaseManifest{}, fmt.Errorf("release manifest does not bind expected asset %q", expectedAsset)
}

// VerifySignature checks the detached minisign signature against the pinned key.
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

// normalizeSignatureText returns the raw minisign document; `tauri signer sign`
// emits base64-wrapped ones, raw ones pass through.
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

func readerSHA256(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", fmt.Errorf("computing checksum: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("opening file for checksum: %w", err)
	}
	defer f.Close() //nolint:errcheck

	return readerSHA256(f)
}

// VerifyChecksum compares the SHA256 of filePath with expectedHash, case-insensitively.
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

// StagedBinary is an open handle to a staged binary verified through that same
// handle, so a path swap before rename is detected, not executed (TOCTOU).
type StagedBinary struct {
	f      *os.File
	closed bool
}

// OpenVerifiedBinary opens stagedPath once and verifies its SHA256 through that
// handle (expectedHash is case-insensitive hex). The caller must Close the result.
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

// Commit renames the staged file to destPath and confirms (os.SameFile against
// the verification handle) that destPath is the verified file. On a swap it
// errors and the caller must treat destPath as unverified.
func (s *StagedBinary) Commit(destPath string) error {
	verified, err := s.f.Stat()
	if err != nil {
		return fmt.Errorf("stat of verified handle: %w", err)
	}
	if runtime.GOOS == "windows" {
		// Windows cannot rename a file Go holds open, so the lock blocks swaps until
		// here; the NTFS file ID captured above survives the rename for the same-file check.
		if err := s.Close(); err != nil {
			return fmt.Errorf("closing verified handle: %w", err)
		}
	}
	// On Unix the open fd pins the verified inode against reuse.
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

// Close releases the verification handle.
func (s *StagedBinary) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.f.Close()
}

// ParseChecksumFile returns the hash for filename from sha256sum-format content.
func (u *Updater) ParseChecksumFile(data []byte, filename string) (string, error) {
	lines := strings.SplitSeq(string(data), "\n")
	for line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Two spaces per sha256sum; single-space separation is tolerated.
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[len(parts)-1] == filename {
			return parts[0], nil
		}
	}
	return "", fmt.Errorf("file %q not found in checksum data", filename)
}

// ReleaseProtocolEpoch returns the epoch from a release's signed manifest. No
// manifest means epoch 0; an unverifiable signature is an error, never a guess.
// Fetches use the text-asset cache.
func (u *Updater) ReleaseProtocolEpoch(ctx context.Context, info UpdateInfo) (int, error) {
	if info.ManifestURL == "" || info.ManifestSignatureURL == "" {
		return 0, nil
	}
	manifestText, err := u.FetchTextAssetCached(ctx, info.ManifestURL)
	if err != nil {
		return 0, fmt.Errorf("fetching release manifest: %w", err)
	}
	sigText, err := u.FetchTextAssetCached(ctx, info.ManifestSignatureURL)
	if err != nil {
		return 0, fmt.Errorf("fetching release manifest signature: %w", err)
	}
	if err := u.verifySignatureReader(strings.NewReader(manifestText), []byte(sigText), manifestAsset); err != nil {
		return 0, fmt.Errorf("verifying release manifest signature: %w", err)
	}
	var manifest releaseManifest
	if err := json.Unmarshal([]byte(manifestText), &manifest); err != nil {
		return 0, fmt.Errorf("parsing release manifest: %w", err)
	}
	return manifest.ProtocolEpoch, nil
}
