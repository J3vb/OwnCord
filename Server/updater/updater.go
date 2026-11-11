// Package updater checks GitHub Releases for server updates and downloads
// checksum- and signature-verified binaries.
package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"

	"golang.org/x/mod/semver"
	"golang.org/x/sync/singleflight"
)

const (
	defaultBaseURL = "https://api.github.com"
	cacheTTL       = 1 * time.Hour

	// maxFetchBytes caps checksum/signature bodies so a bad asset cannot exhaust memory.
	maxFetchBytes = config.MaxMessageBytes
	errorCacheTTL = 5 * time.Minute
	// fetchTimeout bounds a metadata fetch once detached from the caller's context (see detachFetch).
	fetchTimeout = 30 * time.Second
	// metadataClientTimeout bounds a whole metadata exchange, not the asset download.
	metadataClientTimeout = 30 * time.Second
	// responseHeaderTimeout abandons a server that accepts the connection and stays silent.
	responseHeaderTimeout = 30 * time.Second
	// defaultDownloadStallTimeout abandons a download with no body bytes for this long.
	defaultDownloadStallTimeout = 60 * time.Second
	checksumAsset               = "checksums.sha256"
	manifestAsset               = "server-update-manifest.json"
	manifestSigAsset            = manifestAsset + ".sig"

	// The amd64 asset names are frozen: servers deployed before arm64 existed match
	// them exactly, so renaming would strand them on their current version.
	windowsServerBinary      = "chatserver.exe"
	linuxServerArchive       = "chatserver-linux-amd64.tar.gz"
	windowsServerArm64Binary = "chatserver-windows-arm64.exe"
	linuxServerArm64Archive  = "chatserver-linux-arm64.tar.gz"
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

type releaseResponse struct {
	TagName string          `json:"tag_name"`
	Body    string          `json:"body"`
	HTMLURL string          `json:"html_url"`
	Assets  []assetResponse `json:"assets"`
}

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
	// downloadStallTimeout aborts a download with no body bytes for this long; zero means the default.
	downloadStallTimeout time.Duration
}

var (
	sharedTransportOnce sync.Once
	sharedTransport     atomic.Pointer[http.Transport]
)

// CloseIdleConnections closes the idle connections of the shared transport; safe before any Updater exists.
func CloseIdleConnections() {
	if t := sharedTransport.Load(); t != nil {
		t.CloseIdleConnections()
	}
}

// NewUpdater creates an Updater for the given repository.
func NewUpdater(currentVersion, githubToken, repoOwner, repoName string) *Updater {
	u := &Updater{
		currentVersion: currentVersion,
		githubToken:    githubToken,
		repoOwner:      repoOwner,
		repoName:       repoName,
		signingKeyText: defaultServerSignaturePublicKey,
	}
	// One transport is shared by every Updater so CloseIdleConnections can release
	// them together; it is built here, in the inventoried egress site
	// (invariants.EgressAllow), and every redirect hop passes the same host check.
	sharedTransportOnce.Do(func() {
		var transport *http.Transport
		if base, ok := http.DefaultTransport.(*http.Transport); ok {
			transport = base.Clone()
		} else {
			transport = &http.Transport{
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{
					Timeout:   30 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				ExpectContinueTimeout: time.Second,
				ForceAttemptHTTP2:     true,
				TLSHandshakeTimeout:   10 * time.Second,
				IdleConnTimeout:       90 * time.Second,
			}
		}
		transport.ResponseHeaderTimeout = responseHeaderTimeout
		sharedTransport.Store(transport)
	})
	u.httpClient = &http.Client{
		Transport: sharedTransport.Load(),
		Timeout:   metadataClientTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after %d redirects", len(via))
			}
			if !u.trustedURL(req.URL.String()) {
				return fmt.Errorf("refusing redirect to %s: not a GitHub release host", req.URL.Host)
			}
			return nil
		},
	}
	return u
}

// SetBaseURL overrides the GitHub API base URL (for testing).
func (u *Updater) SetBaseURL(url string) {
	u.baseURL = url
}

// ensureVPrefix returns v with a "v" prefix for semver comparison.
func ensureVPrefix(v string) string {
	if strings.HasPrefix(v, "v") {
		return v
	}
	return "v" + v
}

func (u *Updater) apiBaseURL() string {
	if u.baseURL != "" {
		return u.baseURL
	}
	return defaultBaseURL
}

// detachFetch returns a context carrying ctx's values but not its cancellation,
// bounded by fetchTimeout. The release and text-asset caches are process-wide
// and shared by unauthenticated and owner-only callers, so driving a fetch from
// one caller's context would let an aborted request cache context.Canceled as a
// failure for errorCacheTTL and block update checks for everyone.
func detachFetch(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
}

// CheckForUpdate compares the latest GitHub release with the current version.
// Results are cached for cacheTTL and errors for errorCacheTTL; the fetch is
// detached from ctx, so cancelling it never writes a failure into the shared cache.
func (u *Updater) CheckForUpdate(ctx context.Context) (UpdateInfo, error) {
	if info, err, ok := u.lookupRelease(time.Now()); ok {
		return info, err
	}

	// Coalesce concurrent misses into one flight, detached from the leader's ctx so
	// an aborted leader cannot fail followers or cache its own context.Canceled.
	v, err, _ := u.releaseSF.Do("latest-release", func() (any, error) {
		now := time.Now()
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

// lookupRelease returns a live cached release or error; the bool reports a live
// cache hit (false means the caller must fetch).
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

	updateAvailable := semver.Compare(currentV, latestV) < 0

	var downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL string
	assets := make([]Asset, 0, len(release.Assets))
	wantBinary := serverDownloadAssetName(runtime.GOOS, runtime.GOARCH)
	// Paired with wantBinary: a Windows arm64 host matching the amd64 signature would fail verification.
	wantSignature := serverSignatureAssetName(runtime.GOOS, runtime.GOARCH)
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
		case wantSignature != "" && strings.EqualFold(asset.Name, wantSignature):
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

// hasRequiredServerAssetsFor reports whether every asset the goos verify path
// consumes is present. The binary signature is Windows-only (Linux verifies via
// the signed manifest + checksum), so requiring it there would block Linux updates.
func hasRequiredServerAssetsFor(goos, downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL string) bool {
	if goos == "windows" && signatureURL == "" {
		return false
	}
	return downloadURL != "" && checksumURL != "" && manifestURL != "" && manifestSignatureURL != ""
}
