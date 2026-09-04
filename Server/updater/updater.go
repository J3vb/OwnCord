// Package updater checks GitHub Releases for server updates and manages
// binary downloads with checksum verification.
package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"

	"golang.org/x/mod/semver"
	"golang.org/x/sync/singleflight"
)

const (
	defaultBaseURL = "https://api.github.com"
	cacheTTL       = 1 * time.Hour

	// maxFetchBytes caps the response body read for checksum/signature files.
	// Prevents a malicious or corrupted release asset from exhausting memory.
	maxFetchBytes = config.MaxMessageBytes
	errorCacheTTL = 5 * time.Minute
	// fetchTimeout bounds an outbound metadata fetch once it has been detached
	// from the caller's context (see detachFetch). It matches the http.Client
	// timeout NewUpdater sets, so a caller that stays connected sees the same
	// effective deadline as before.
	fetchTimeout     = 30 * time.Second
	checksumAsset    = "checksums.sha256"
	signatureAsset   = windowsServerBinary + ".sig"
	manifestAsset    = "server-update-manifest.json"
	manifestSigAsset = manifestAsset + ".sig"

	windowsServerBinary = "chatserver.exe"
	linuxServerArchive  = "chatserver-linux-amd64.tar.gz"
)

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

// Asset is a simplified release asset with name and download URL.
type Asset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"download_url"`
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
	textAssetCache map[string]textAssetCacheEntry
	textAssetSF    singleflight.Group
	releaseSF      singleflight.Group
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

// detachFetch returns a context carrying ctx's values but not its
// cancellation, bounded by fetchTimeout.
//
// The release and text-asset caches are process-wide and shared by the
// unauthenticated client-update endpoint and the owner-only admin update
// handlers, so the outcome of one caller's fetch is replayed to every other
// caller. Driving the fetch from the caller's own context let an
// unauthenticated client abort its request and have the resulting
// context.Canceled stored as a cached failure for errorCacheTTL, blocking
// update checks for everyone. Detaching the fetch means only upstream-derived
// errors (dial failure, non-200 status, decode failure, or this timeout) can
// ever reach the cache — those stay cached exactly as before — and a fetch
// already in flight completes and fills the success cache even if the caller
// that started it walks away.
func detachFetch(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
}

// CheckForUpdate queries GitHub for the latest release and compares it
// against the current version. Results are cached for cacheTTL; errors
// are cached for errorCacheTTL to avoid spamming the GitHub API. The outbound
// fetch is detached from ctx (see detachFetch), so cancelling ctx does not
// abort it or write a failure into the shared cache.
func (u *Updater) CheckForUpdate(ctx context.Context) (UpdateInfo, error) {
	if info, err, ok := u.lookupRelease(time.Now()); ok {
		return info, err
	}

	// Coalesce concurrent misses: when the cache TTL expires under load, every
	// caller would otherwise issue its own outbound GitHub fetch (OC-0146).
	// One flight runs and the rest wait on its result, exactly like
	// FetchTextAssetCached's textAssetSF.
	//
	// The flight is detached from the leader's ctx (see detachFetch): callers
	// include the unauthenticated client-update endpoint, so a leader that
	// aborts its request must not fail its followers or write its own
	// context.Canceled into the shared cache.
	v, err, _ := u.releaseSF.Do("latest-release", func() (any, error) {
		now := time.Now()
		// Re-check: another flight may have filled the cache while we queued.
		if info, err, ok := u.lookupRelease(now); ok {
			return info, err
		}

		fetchCtx, cancel := detachFetch(ctx)
		defer cancel()

		info, err := u.fetchLatestRelease(fetchCtx)
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
	})
	if err != nil {
		return UpdateInfo{}, err
	}
	return v.(UpdateInfo), nil
}

// lookupRelease returns a live cached release or cached error, if either
// exists. The third return value reports whether the cache was live (a
// caller should return the first two values directly); a false miss means
// the caller must fetch.
func (u *Updater) lookupRelease(now time.Time) (UpdateInfo, error, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.cache != nil && now.Before(u.cacheExpiry) {
		return *u.cache, nil, true
	}
	if u.cachedErr != nil && now.Before(u.errCacheExpiry) {
		return UpdateInfo{}, u.cachedErr, true
	}
	return UpdateInfo{}, nil, false
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
	wantBinary := serverDownloadAssetName(runtime.GOOS, runtime.GOARCH)
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
	requiredAssetsPresent := hasRequiredServerAssetsFor(runtime.GOOS, downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL)
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

// hasRequiredServerAssetsFor reports whether every asset the goos-specific
// verify path consumes is present. The detached binary signature
// (chatserver.exe.sig) is Windows-only: the Linux tarball path verifies via
// the signed manifest + checksum and never receives it, so requiring it there
// would block Linux updates on any release missing a Windows-only asset.
func hasRequiredServerAssetsFor(goos, downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL string) bool {
	if goos == "windows" && signatureURL == "" {
		return false
	}
	return downloadURL != "" && checksumURL != "" && manifestURL != "" && manifestSignatureURL != ""
}
