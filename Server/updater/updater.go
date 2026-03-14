// Package updater checks GitHub Releases for server updates and manages
// binary downloads with checksum verification.
package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"
)

const (
	defaultBaseURL = "https://api.github.com"
	cacheTTL       = 1 * time.Hour
	binaryAsset    = "chatserver.exe"
	checksumAsset  = "checksums.sha256"
)

// UpdateInfo holds the result of a version check.
type UpdateInfo struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"update_available"`
	ReleaseURL      string `json:"release_url"`
	DownloadURL     string `json:"download_url"`
	ChecksumURL     string `json:"checksum_url"`
	ReleaseNotes    string `json:"release_notes"`
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

	cache       *UpdateInfo
	cacheExpiry time.Time
	mu          sync.Mutex
	httpClient  *http.Client
}

// NewUpdater creates an Updater for the given repository.
func NewUpdater(currentVersion, githubToken, repoOwner, repoName string) *Updater {
	return &Updater{
		currentVersion: currentVersion,
		githubToken:    githubToken,
		repoOwner:      repoOwner,
		repoName:       repoName,
		httpClient:     &http.Client{Timeout: 30 * time.Second},
	}
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
// against the current version. Results are cached for cacheTTL.
func (u *Updater) CheckForUpdate(ctx context.Context) (UpdateInfo, error) {
	u.mu.Lock()
	if u.cache != nil && time.Now().Before(u.cacheExpiry) {
		cached := *u.cache
		u.mu.Unlock()
		return cached, nil
	}
	u.mu.Unlock()

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
	defer resp.Body.Close()

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

	var downloadURL, checksumURL string
	for _, asset := range release.Assets {
		switch asset.Name {
		case binaryAsset:
			downloadURL = asset.BrowserDownloadURL
		case checksumAsset:
			checksumURL = asset.BrowserDownloadURL
		}
	}

	info := UpdateInfo{
		Current:         currentV,
		Latest:          latestV,
		UpdateAvailable: updateAvailable,
		ReleaseURL:      release.HTMLURL,
		DownloadURL:     downloadURL,
		ChecksumURL:     checksumURL,
		ReleaseNotes:    release.Body,
	}

	u.mu.Lock()
	u.cache = &info
	u.cacheExpiry = time.Now().Add(cacheTTL)
	u.mu.Unlock()

	return info, nil
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

// DownloadAndVerify downloads the binary from downloadURL, fetches the
// checksum file from checksumURL, and verifies the SHA256 hash matches.
// On checksum mismatch the downloaded file is removed.
func (u *Updater) DownloadAndVerify(ctx context.Context, downloadURL, checksumURL, destPath string) error {
	if err := u.ValidateDownloadURL(downloadURL); err != nil {
		return err
	}

	// Fetch checksum file.
	checksumData, err := u.fetchBody(ctx, checksumURL)
	if err != nil {
		return fmt.Errorf("fetching checksums: %w", err)
	}

	destFilename := filepath.Base(destPath)
	expectedHash, err := u.ParseChecksumFile(checksumData, destFilename)
	if err != nil {
		return fmt.Errorf("parsing checksum file: %w", err)
	}

	// Download the binary.
	if err := u.downloadFile(ctx, downloadURL, destPath); err != nil {
		return fmt.Errorf("downloading binary: %w", err)
	}

	// Verify hash.
	if err := u.VerifyChecksum(destPath, expectedHash); err != nil {
		// Remove the invalid file.
		_ = os.Remove(destPath)
		return err
	}

	return nil
}

// VerifyChecksum computes the SHA256 hash of the file at filePath and
// compares it (case-insensitive) against expectedHash.
func (u *Updater) VerifyChecksum(filePath, expectedHash string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("opening file for checksum: %w", err)
	}
	defer f.Close()

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

// fetchBody performs a GET request and returns the response body as bytes.
func (u *Updater) fetchBody(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if u.githubToken != "" {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}

	return io.ReadAll(resp.Body)
}

// downloadFile downloads the content at url and writes it to destPath.
func (u *Updater) downloadFile(ctx context.Context, url, destPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if u.githubToken != "" {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("creating destination file: %w", err)
	}
	defer f.Close()

	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("writing downloaded file: %w", err)
	}

	return nil
}
