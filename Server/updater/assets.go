package updater

import (
	"context"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"path"
	"strings"
	"time"
)

// ClientAssets holds the URLs for Tauri client update artifacts.
type ClientAssets struct {
	InstallerURL string
	SignatureURL string
}

// textAssetCacheEntry caches a small text asset (e.g. a client update .sig
// file) alongside the release cache so repeated requests are served from
// memory instead of re-fetching from GitHub on every call.
type textAssetCacheEntry struct {
	content string
	// err caches a failed fetch so an upstream outage is not re-dialled on
	// every request. Cached errors expire after errorCacheTTL, successes
	// after cacheTTL.
	err    error
	expiry time.Time
}

// clientAssetSuffixByTarget maps a Tauri updater target
// ("{os}-{arch}-{installer}") to the release asset suffix for that platform's
// updater artifact. The matching signature asset is the same suffix plus
// ".sig". Targets without a published updater artifact are absent — notably
// linux-*-deb: the release ships .deb packages but no signed deb updater
// artifact, and serving the AppImage archive instead would make the plugin's
// install_deb reject every update.
var clientAssetSuffixByTarget = map[string]string{
	"windows-x86_64-nsis":    "_x64-setup.nsis.zip",
	"linux-x86_64-appimage":  "_amd64.AppImage.tar.gz",
	"linux-aarch64-appimage": "_aarch64.AppImage.tar.gz",
}

// FindClientAssets scans the cached release assets for the client updater
// artifact and its signature matching the given Tauri updater target
// (e.g. "windows-x86_64-nsis"). Unknown targets return empty ClientAssets.
func (u *Updater) FindClientAssets(target string) ClientAssets {
	suffix, ok := clientAssetSuffixByTarget[target]
	if !ok {
		return ClientAssets{}
	}

	u.mu.Lock()
	defer u.mu.Unlock()

	if u.cache == nil {
		return ClientAssets{}
	}

	var ca ClientAssets
	for _, a := range u.cache.Assets {
		switch {
		case strings.HasSuffix(a.Name, suffix+".sig"):
			ca.SignatureURL = a.DownloadURL
		case strings.HasSuffix(a.Name, suffix):
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

// FetchTextAssetCached is FetchTextAsset with an in-memory cache keyed by URL,
// using the same cacheTTL as the release cache. It lets unauthenticated,
// unrate-limited callers (e.g. the client-update endpoint) be served from
// memory instead of triggering an outbound fetch on every request.
func (u *Updater) FetchTextAssetCached(ctx context.Context, url string) (string, error) {
	if entry, ok := u.lookupTextAsset(url, time.Now()); ok {
		return entry.content, entry.err
	}

	// Coalesce concurrent misses: when the TTL expires under load, every caller
	// would otherwise issue its own outbound fetch. One flight per URL runs and
	// the rest wait on its result.
	//
	// The flight is detached from the leader's ctx (see detachFetch): callers
	// are the unauthenticated client-update endpoint, so a leader that aborts
	// its request must not fail its followers or write its own
	// context.Canceled into the shared negative cache.
	v, err, _ := u.textAssetSF.Do(url, func() (any, error) {
		now := time.Now()
		// Re-check: another flight may have filled the cache while we queued.
		if entry, ok := u.lookupTextAsset(url, now); ok {
			return entry.content, entry.err
		}
		fetchCtx, cancel := detachFetch(ctx)
		defer cancel()
		content, fetchErr := u.FetchTextAsset(fetchCtx, url)
		u.storeTextAsset(url, content, fetchErr, now)
		return content, fetchErr
	})
	if err != nil {
		return "", err
	}
	return v.(string), nil
}

// lookupTextAsset returns a live cache entry for url, if one exists. A cached
// entry may hold either content or an error; both are honoured until expiry.
func (u *Updater) lookupTextAsset(url string, now time.Time) (textAssetCacheEntry, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	entry, ok := u.textAssetCache[url]
	if !ok || !now.Before(entry.expiry) {
		return textAssetCacheEntry{}, false
	}
	return entry, true
}

// storeTextAsset records the outcome of a fetch, caching failures briefly so an
// upstream outage does not trigger an outbound request per caller.
func (u *Updater) storeTextAsset(url, content string, err error, now time.Time) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.textAssetCache == nil {
		u.textAssetCache = make(map[string]textAssetCacheEntry)
	}
	// Drop superseded keys: asset URLs carry a version, so without this the map
	// grows by one entry per release for the lifetime of the process.
	for k, e := range u.textAssetCache {
		if !now.Before(e.expiry) {
			delete(u.textAssetCache, k)
		}
	}
	ttl := cacheTTL
	if err != nil {
		ttl = errorCacheTTL
	}
	u.textAssetCache[url] = textAssetCacheEntry{content: content, err: err, expiry: now.Add(ttl)}
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
	return io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes))
}
