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

type textAssetCacheEntry struct {
	content string
	// err caches a failed fetch for errorCacheTTL so an outage is not re-dialled per request.
	err    error
	expiry time.Time
}

// clientAssetSuffixByTarget maps a Tauri target ("{os}-{arch}-{installer}") to
// its updater artifact suffix; the signature is the suffix plus ".sig". The
// linux-*-deb entries are served only to clients that opt in (api/client_update.go
// debOptIn); others get 204 first, since they cannot install a .deb. The Android
// entry is the signed APK, which the app verifies and hands to the package installer.
var clientAssetSuffixByTarget = map[string]string{
	"windows-x86_64-nsis":    "_x64-setup.nsis.zip",
	"windows-aarch64-nsis":   "_arm64-setup.nsis.zip",
	"linux-x86_64-appimage":  "_amd64.AppImage.tar.gz",
	"linux-aarch64-appimage": "_aarch64.AppImage.tar.gz",
	"linux-x86_64-deb":       "_amd64.deb",
	"linux-aarch64-deb":      "_arm64.deb",
	"android-aarch64-apk":    "_arm64.apk",
}

// FindClientAssets returns the cached release's updater artifact and signature
// for a Tauri target (e.g. "windows-x86_64-nsis"); unknown targets return empty ClientAssets.
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

// FetchTextAsset downloads a small text asset (e.g. a .sig file).
func (u *Updater) FetchTextAsset(ctx context.Context, url string) (string, error) {
	data, err := u.fetchBody(ctx, url)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// FetchTextAssetCached is FetchTextAsset cached by URL for cacheTTL, so the
// rate-limited unauthenticated client-update endpoint does no outbound fetch per request.
func (u *Updater) FetchTextAssetCached(ctx context.Context, url string) (string, error) {
	if entry, ok := u.lookupTextAsset(url, time.Now()); ok {
		return entry.content, entry.err
	}

	// Coalesce concurrent misses into one flight per URL, detached from the
	// leader's ctx so an aborted leader cannot fail followers or cache context.Canceled.
	v, err, _ := u.textAssetSF.Do(url, func() (any, error) {
		now := time.Now()
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

// lookupTextAsset returns a live cache entry (content or error) for url.
func (u *Updater) lookupTextAsset(url string, now time.Time) (textAssetCacheEntry, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	entry, ok := u.textAssetCache[url]
	if !ok || !now.Before(entry.expiry) {
		return textAssetCacheEntry{}, false
	}
	return entry, true
}

// storeTextAsset records a fetch outcome; failures are cached briefly so an outage is not re-fetched per
// caller.
func (u *Updater) storeTextAsset(url, content string, err error, now time.Time) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.textAssetCache == nil {
		u.textAssetCache = make(map[string]textAssetCacheEntry)
	}
	// Drop superseded keys: asset URLs carry a version, so the map would grow per release.
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

// trustedURL reports whether rawURL may be fetched and carry the GitHub token:
// an https GitHub host or the test base URL. Asset URLs come from release JSON,
// so every fetch and redirect hop must pass it.
func (u *Updater) trustedURL(rawURL string) bool {
	if u.baseURL != "" && (rawURL == u.baseURL || strings.HasPrefix(rawURL, strings.TrimSuffix(u.baseURL, "/")+"/")) {
		return true
	}
	parsed, err := neturl.Parse(rawURL)
	return err == nil && parsed.Scheme == "https" && isGitHubHost(rawURL)
}

func (u *Updater) fetchBody(ctx context.Context, url string) ([]byte, error) {
	if !u.trustedURL(url) {
		return nil, fmt.Errorf("refusing to fetch %s: not a GitHub release host", url)
	}
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
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}

	// Cap reads at 1 MiB: checksum and signature files are tiny text.
	return io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes))
}
