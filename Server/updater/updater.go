// Package updater checks GitHub Releases for server updates and manages
// binary downloads with checksum verification.
package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"aead.dev/minisign"

	"github.com/owncord/server/syncutil"

	"golang.org/x/mod/semver"
)

const (
	defaultBaseURL   = "https://api.github.com"
	cacheTTL         = 1 * time.Hour
	errorCacheTTL    = 5 * time.Minute
	checksumAsset    = "checksums.sha256"
	signatureAsset   = windowsServerBinary + ".sig"
	manifestAsset    = "server-update-manifest.json"
	manifestSigAsset = manifestAsset + ".sig"

	windowsServerBinary = "chatserver.exe"
	linuxServerArchive  = "chatserver-linux-amd64.tar.gz"
)

// serverUpdatePublicKeyText is the pinned public key for server update
// signatures. Keep this file in sync with the SERVER_UPDATE_SIGNING_* CI
// secrets when rotating the server updater keypair.
//
//go:embed server_update_public_key.txt
var serverUpdatePublicKeyText string

var defaultServerSignaturePublicKey = strings.TrimSpace(serverUpdatePublicKeyText)

// UpdateInfo holds the result of a version check.
type UpdateInfo struct {
	Current               string  `json:"current"`
	Latest                string  `json:"latest"`
	UpdateAvailable       bool    `json:"update_available"`
	RequiredAssetsPresent bool    `json:"required_assets_present"`
	ReleaseURL            string  `json:"release_url"`
	DownloadURL           string  `json:"download_url"`
	ChecksumURL           string  `json:"checksum_url"`
	SignatureURL          string  `json:"signature_url"`
	ManifestURL           string  `json:"manifest_url"`
	ManifestSignatureURL  string  `json:"manifest_signature_url"`
	ReleaseNotes          string  `json:"release_notes"`
	Assets                []Asset `json:"assets,omitempty"`
}

type releaseManifest struct {
	Version string `json:"version"`
	Asset   string `json:"asset"`
	SHA256  string `json:"sha256"`
}

// Asset is a simplified release asset with name and download URL.
type Asset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"download_url"`
}

// ClientAssets holds the URLs for Tauri client update artifacts.
type ClientAssets struct {
	InstallerURL string
	SignatureURL string
}

// releaseResponse mirrors the subset of GitHub's release API we need.
type releaseResponse struct {
	TagName string          `json:"tag_name"`
	Body    string          `json:"body"`
	HTMLURL string          `json:"html_url"`
	Assets  []assetResponse `json:"assets"`
}

// assetResponse mirrors a single release asset from the GitHub API.
type assetResponse struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// Updater checks GitHub Releases for updates and manages binary downloads.
type Updater struct {
	currentVersion string
	githubToken    string
	repoOwner      string
	repoName       string
	baseURL        string // override for testing; empty uses defaultBaseURL

	cache          *UpdateInfo
	cacheExpiry    time.Time
	cachedErr      error
	errCacheExpiry time.Time
	mu             syncutil.Mutex
	httpClient     *http.Client
	signingKeyText string
}

// NewUpdater creates an Updater for the given repository.
func NewUpdater(currentVersion, githubToken, repoOwner, repoName string) *Updater {
	return &Updater{
		currentVersion: currentVersion,
		githubToken:    githubToken,
		repoOwner:      repoOwner,
		repoName:       repoName,
		httpClient:     &http.Client{Timeout: 30 * time.Second},
		signingKeyText: defaultServerSignaturePublicKey,
	}
}

// SetBaseURL overrides the GitHub API base URL (for testing).
func (u *Updater) SetBaseURL(url string) {
	u.baseURL = url
}

// ensureVPrefix returns the version string with a "v" prefix for semver
// comparison. If it already has one, it is returned unchanged.
func ensureVPrefix(v string) string {
	if strings.HasPrefix(v, "v") {
		return v
	}
	return "v" + v
}

// apiBaseURL returns the effective base URL for GitHub API requests.
func (u *Updater) apiBaseURL() string {
	if u.baseURL != "" {
		return u.baseURL
	}
	return defaultBaseURL
}

// CheckForUpdate queries GitHub for the latest release and compares it
// against the current version. Results are cached for cacheTTL; errors
// are cached for errorCacheTTL to avoid spamming the GitHub API.
func (u *Updater) CheckForUpdate(ctx context.Context) (UpdateInfo, error) {
	now := time.Now()
	u.mu.Lock()
	if u.cache != nil && now.Before(u.cacheExpiry) {
		cached := *u.cache
		u.mu.Unlock()
		return cached, nil
	}
	if u.cachedErr != nil && now.Before(u.errCacheExpiry) {
		err := u.cachedErr
		u.mu.Unlock()
		return UpdateInfo{}, err
	}
	u.mu.Unlock()

	info, err := u.fetchLatestRelease(ctx)
	if err != nil {
		u.mu.Lock()
		u.cachedErr = err
		u.errCacheExpiry = now.Add(errorCacheTTL)
		u.mu.Unlock()
		return UpdateInfo{}, err
	}

	u.mu.Lock()
	u.cache = &info
	u.cacheExpiry = now.Add(cacheTTL)
	u.cachedErr = nil
	u.mu.Unlock()

	return info, nil
}

// fetchLatestRelease queries the GitHub API for the latest release and
// builds the UpdateInfo struct.
func (u *Updater) fetchLatestRelease(ctx context.Context) (UpdateInfo, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases/latest", u.apiBaseURL(), u.repoOwner, u.repoName)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return UpdateInfo{}, fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if u.githubToken != "" {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return UpdateInfo{}, fmt.Errorf("fetching latest release: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return UpdateInfo{}, fmt.Errorf("github API returned status %d", resp.StatusCode)
	}

	var release releaseResponse
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return UpdateInfo{}, fmt.Errorf("decoding release response: %w", err)
	}

	currentV := ensureVPrefix(u.currentVersion)
	latestV := ensureVPrefix(release.TagName)

	// semver.Compare returns -1, 0, or +1. Update available when current < latest.
	updateAvailable := semver.Compare(currentV, latestV) < 0

	var downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL string
	assets := make([]Asset, 0, len(release.Assets))
	wantBinary := serverDownloadAssetName(runtime.GOOS)
	for _, asset := range release.Assets {
		assets = append(assets, Asset{
			Name:        asset.Name,
			DownloadURL: asset.BrowserDownloadURL,
		})
		switch {
		case wantBinary != "" && strings.EqualFold(asset.Name, wantBinary):
			downloadURL = asset.BrowserDownloadURL
		case strings.EqualFold(asset.Name, checksumAsset):
			checksumURL = asset.BrowserDownloadURL
		case strings.EqualFold(asset.Name, signatureAsset):
			signatureURL = asset.BrowserDownloadURL
		case strings.EqualFold(asset.Name, manifestAsset):
			manifestURL = asset.BrowserDownloadURL
		case strings.EqualFold(asset.Name, manifestSigAsset):
			manifestSignatureURL = asset.BrowserDownloadURL
		}
	}
	requiredAssetsPresent := hasRequiredServerAssets(downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL)
	updateAvailable = updateAvailable && requiredAssetsPresent

	return UpdateInfo{
		Current:               currentV,
		Latest:                latestV,
		UpdateAvailable:       updateAvailable,
		RequiredAssetsPresent: requiredAssetsPresent,
		ReleaseURL:            release.HTMLURL,
		DownloadURL:           downloadURL,
		ChecksumURL:           checksumURL,
		SignatureURL:          signatureURL,
		ManifestURL:           manifestURL,
		ManifestSignatureURL:  manifestSignatureURL,
		ReleaseNotes:          release.Body,
		Assets:                assets,
	}, nil
}

func hasRequiredServerAssets(downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL string) bool {
	return downloadURL != "" && checksumURL != "" && signatureURL != "" && manifestURL != "" && manifestSignatureURL != ""
}

// ValidateDownloadURL ensures the URL points to an expected GitHub release
// asset for this repository.
func (u *Updater) ValidateDownloadURL(url string) error {
	prefix := fmt.Sprintf("https://github.com/%s/%s/releases/download/", u.repoOwner, u.repoName)
	if !strings.HasPrefix(url, prefix) {
		return fmt.Errorf("download URL %q does not match expected prefix %q", url, prefix)
	}
	return nil
}

// DownloadAndVerify downloads the release artifact from downloadURL, fetches
// the checksum file, the detached binary signature, and a signed release
// manifest, and verifies that the downloaded asset matches both the release
// version and the pinned signing key. On Windows the asset is a single
// executable; on Linux it is a tar.gz archive containing a "chatserver"
// binary, which is extracted to destPath. On verification failure the
// downloaded file is removed.
func (u *Updater) DownloadAndVerify(ctx context.Context, latestVersion, downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, destPath string) error {
	if err := u.ValidateDownloadURL(downloadURL); err != nil {
		return err
	}
	if err := u.ValidateDownloadURL(checksumURL); err != nil {
		return fmt.Errorf("validating checksum URL: %w", err)
	}
	if err := u.ValidateDownloadURL(signatureURL); err != nil {
		return fmt.Errorf("validating signature URL: %w", err)
	}
	if err := u.ValidateDownloadURL(manifestURL); err != nil {
		return fmt.Errorf("validating manifest URL: %w", err)
	}
	if err := u.ValidateDownloadURL(manifestSignatureURL); err != nil {
		return fmt.Errorf("validating manifest signature URL: %w", err)
	}

	checksumData, err := u.fetchBody(ctx, checksumURL)
	if err != nil {
		return fmt.Errorf("fetching checksums: %w", err)
	}
	signatureData, err := u.fetchBody(ctx, signatureURL)
	if err != nil {
		return fmt.Errorf("fetching signature: %w", err)
	}
	manifestData, err := u.fetchBody(ctx, manifestURL)
	if err != nil {
		return fmt.Errorf("fetching release manifest: %w", err)
	}
	manifestSignatureData, err := u.fetchBody(ctx, manifestSignatureURL)
	if err != nil {
		return fmt.Errorf("fetching release manifest signature: %w", err)
	}

	assetFilename, err := assetFilenameFromURL(downloadURL)
	if err != nil {
		return fmt.Errorf("determining asset filename: %w", err)
	}
	manifest, err := u.VerifyReleaseManifest(manifestData, manifestSignatureData, latestVersion, assetFilename)
	if err != nil {
		return err
	}
	expectedHash, err := u.ParseChecksumFile(checksumData, assetFilename)
	if err != nil {
		return fmt.Errorf("parsing checksum file: %w", err)
	}
	if !strings.EqualFold(expectedHash, manifest.SHA256) {
		return fmt.Errorf("release manifest checksum mismatch for %s", assetFilename)
	}

	goos := runtime.GOOS
	switch goos {
	case "windows":
		return u.downloadWindowsBinaryAndVerify(ctx, downloadURL, destPath, expectedHash, signatureData)
	case "linux":
		return u.downloadLinuxTarballAndVerify(ctx, downloadURL, destPath, expectedHash)
	default:
		return fmt.Errorf("server auto-update is not supported on %s", goos)
	}
}

func (u *Updater) downloadWindowsBinaryAndVerify(ctx context.Context, downloadURL, destPath, expectedHash string, signatureData []byte) error {
	if err := u.downloadFile(ctx, downloadURL, destPath); err != nil {
		return fmt.Errorf("downloading binary: %w", err)
	}

	if err := u.VerifySignature(destPath, signatureData); err != nil {
		_ = os.Remove(destPath)
		return err
	}

	// Verify hash.
	if err := u.VerifyChecksum(destPath, expectedHash); err != nil {
		// Remove the invalid file.
		_ = os.Remove(destPath)
		return err
	}
	return nil
}

func (u *Updater) downloadLinuxTarballAndVerify(ctx context.Context, downloadURL, destPath, expectedHash string) error {
	tarPath := destPath + ".tar.gz.partial"
	defer func() { _ = os.Remove(tarPath) }()

	if err := u.downloadFile(ctx, downloadURL, tarPath); err != nil {
		return fmt.Errorf("downloading archive: %w", err)
	}
	if err := u.VerifyChecksum(tarPath, expectedHash); err != nil {
		return err
	}

	f, err := os.Open(tarPath)
	if err != nil {
		return fmt.Errorf("opening archive: %w", err)
	}
	defer f.Close() //nolint:errcheck

	if err := extractChatserverFromTarGz(f, destPath); err != nil {
		_ = os.Remove(destPath)
		return fmt.Errorf("extracting archive: %w", err)
	}
	if err := os.Chmod(destPath, 0o755); err != nil { //nolint:gosec // G302: binary must be world-executable to run
		return fmt.Errorf("chmod binary: %w", err)
	}
	return nil
}

func extractChatserverFromTarGz(r io.Reader, destPath string) error {
	gr, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gr.Close() //nolint:errcheck

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("archive contains no file named chatserver")
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		skipBody := func() error {
			if _, err := io.Copy(io.Discard, io.LimitReader(tr, hdr.Size)); err != nil {
				return err
			}
			return nil
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			if err := skipBody(); err != nil {
				return err
			}
			continue
		}
		if strings.Contains(hdr.Name, "..") {
			if err := skipBody(); err != nil {
				return err
			}
			continue
		}
		if filepath.Base(hdr.Name) != "chatserver" {
			if err := skipBody(); err != nil {
				return err
			}
			continue
		}

		out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(tr, hdr.Size))
		closeErr := out.Close()
		if copyErr != nil {
			_ = os.Remove(destPath)
			return fmt.Errorf("writing binary: %w", copyErr)
		}
		if closeErr != nil {
			_ = os.Remove(destPath)
			return closeErr
		}
		if n != hdr.Size {
			_ = os.Remove(destPath)
			return fmt.Errorf("incomplete tar entry (%d of %d bytes)", n, hdr.Size)
		}
		return nil
	}
}

// serverDownloadAssetName returns the GitHub release asset file name for the
// server binary on the given GOOS (windows, linux). Other values return "".
func serverDownloadAssetName(goos string) string {
	switch goos {
	case "windows":
		return windowsServerBinary
	case "linux":
		return linuxServerArchive
	default:
		return ""
	}
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
	manifest.Asset = strings.TrimSpace(manifest.Asset)
	manifest.SHA256 = strings.ToLower(strings.TrimSpace(manifest.SHA256))

	if manifest.Version == "" || manifest.Asset == "" || manifest.SHA256 == "" {
		return releaseManifest{}, fmt.Errorf("release manifest is missing required fields")
	}
	if manifest.Version != ensureVPrefix(expectedVersion) {
		return releaseManifest{}, fmt.Errorf("release manifest version %q does not match release %q", manifest.Version, ensureVPrefix(expectedVersion))
	}
	if manifest.Asset != expectedAsset {
		return releaseManifest{}, fmt.Errorf("release manifest asset %q does not match expected asset %q", manifest.Asset, expectedAsset)
	}
	if len(manifest.SHA256) != sha256.Size*2 {
		return releaseManifest{}, fmt.Errorf("release manifest checksum for %s has invalid length", manifest.Asset)
	}
	if _, err := hex.DecodeString(manifest.SHA256); err != nil {
		return releaseManifest{}, fmt.Errorf("release manifest checksum for %s is invalid: %w", manifest.Asset, err)
	}

	return manifest, nil
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

	normalizedSig := []byte(strings.TrimSpace(string(signatureText)))
	var parsedSig minisign.Signature
	if err := parsedSig.UnmarshalText(normalizedSig); err != nil {
		return fmt.Errorf("invalid update signature format: %w", err)
	}

	if !verifier.Verify(publicKey, normalizedSig) {
		return fmt.Errorf("signature verification failed for %s", subject)
	}
	return nil
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

func assetFilenameFromURL(rawURL string) (string, error) {
	parsed, err := neturl.Parse(rawURL)
	if err != nil {
		return "", err
	}
	filename := path.Base(parsed.Path)
	if filename == "." || filename == "/" || filename == "" {
		return "", fmt.Errorf("missing asset filename in URL %q", rawURL)
	}
	return filename, nil
}

// VerifyChecksum computes the SHA256 hash of the file at filePath and
// compares it (case-insensitive) against expectedHash.
func (u *Updater) VerifyChecksum(filePath, expectedHash string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("opening file for checksum: %w", err)
	}
	defer f.Close() //nolint:errcheck

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("computing checksum: %w", err)
	}

	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expectedHash) {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedHash, actual)
	}
	return nil
}

// ParseChecksumFile parses a sha256sum-format checksum file (lines of
// "<hash>  <filename>") and returns the hash for the given filename.
func (u *Updater) ParseChecksumFile(data []byte, filename string) (string, error) {
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
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

// isGitHubHost reports whether the given URL points to a GitHub domain.
func isGitHubHost(rawURL string) bool {
	u, err := neturl.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "api.github.com" || host == "github.com" ||
		strings.HasSuffix(host, ".github.com") ||
		strings.HasSuffix(host, ".githubusercontent.com")
}

// shouldSendToken reports whether the GitHub token should be attached to a
// request for the given URL. It returns true for GitHub hosts and for any URL
// that starts with the configured baseURL (which may be a test server override).
func (u *Updater) shouldSendToken(rawURL string) bool {
	if isGitHubHost(rawURL) {
		return true
	}
	if u.baseURL != "" && strings.HasPrefix(rawURL, u.baseURL) {
		return true
	}
	return false
}

// fetchBody performs a GET request and returns the response body as bytes.
func (u *Updater) fetchBody(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if u.githubToken != "" && u.shouldSendToken(url) {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}

	// Cap reads at 1 MiB — checksum and signature files are tiny text;
	// this prevents a malicious or corrupted release asset from exhausting memory.
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

// FindClientAssets scans the cached release assets for the Tauri NSIS
// installer zip and its Ed25519 signature file.
func (u *Updater) FindClientAssets() ClientAssets {
	u.mu.Lock()
	defer u.mu.Unlock()

	if u.cache == nil {
		return ClientAssets{}
	}

	var ca ClientAssets
	for _, a := range u.cache.Assets {
		switch {
		case strings.HasSuffix(a.Name, "_x64-setup.nsis.zip.sig"):
			ca.SignatureURL = a.DownloadURL
		case strings.HasSuffix(a.Name, "_x64-setup.nsis.zip"):
			ca.InstallerURL = a.DownloadURL
		}
	}
	return ca
}

// FetchTextAsset downloads a small text asset (e.g. a .sig file) and returns
// its content as a string.
func (u *Updater) FetchTextAsset(ctx context.Context, url string) (string, error) {
	data, err := u.fetchBody(ctx, url)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// downloadFile downloads the content at url and writes it to destPath.
func (u *Updater) downloadFile(ctx context.Context, url, destPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if u.githubToken != "" && u.shouldSendToken(url) {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("creating destination file: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = f.Close()
		}
	}()

	// Cap download at 500 MiB to prevent unbounded disk usage from a
	// malicious or corrupted release asset.
	const maxBinarySize = 500 * 1024 * 1024
	limitedReader := io.LimitReader(resp.Body, maxBinarySize)

	n, err := io.Copy(f, limitedReader)
	if err != nil {
		_ = f.Close()
		closed = true
		_ = os.Remove(destPath)
		return fmt.Errorf("writing downloaded file: %w", err)
	}
	// Probe for one more byte to detect if the file exceeds the limit.
	if n == maxBinarySize {
		var probe [1]byte
		if extra, _ := resp.Body.Read(probe[:]); extra > 0 {
			_ = f.Close()
			closed = true
			_ = os.Remove(destPath)
			return fmt.Errorf("downloaded file exceeds maximum size of %d bytes", maxBinarySize)
		}
	}

	return nil
}
