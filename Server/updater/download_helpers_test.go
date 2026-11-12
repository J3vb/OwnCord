package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"aead.dev/minisign"
)

const releaseDownloadBase = "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/"

// sha256Hex is the lowercase hex SHA-256 of data, the checksum format
// checksums.sha256 and the signed manifest both carry.
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// serveDownloadAssets serves each body under /download/<name>; a name left
// out of assets answers 404 like a release that lacks the asset.
func serveDownloadAssets(t *testing.T, assets map[string][]byte) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	for name, body := range assets {
		mux.HandleFunc("/download/"+name, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(body)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// routeToServer makes u fetch every GitHub release URL from srv instead.
func routeToServer(u *Updater, srv *httptest.Server) {
	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}
}

// downloadAndVerifyAsset runs DownloadAndVerify for v1.0.0 with the standard
// release URLs, binary asset named asset and its detached signature asset.
func downloadAndVerifyAsset(u *Updater, asset, dest string) (string, error) {
	return u.DownloadAndVerify(context.Background(), "v1.0.0",
		releaseDownloadBase+asset,
		releaseDownloadBase+"checksums.sha256",
		releaseDownloadBase+asset+".sig",
		releaseDownloadBase+"server-update-manifest.json",
		releaseDownloadBase+"server-update-manifest.json.sig",
		dest)
}

// windowsDownloadFixture is a signed chatserver.exe release served locally:
// the binary, its checksum line, its detached signature and a signed
// manifest, each overridable before serve is called.
type windowsDownloadFixture struct {
	updater           *Updater
	key               minisign.PrivateKey
	content           []byte
	checksumLine      string
	signature         []byte
	manifest          []byte
	manifestSignature []byte
	dest              string
}

func newWindowsDownloadFixture(t *testing.T, content []byte, manifestVersion string) *windowsDownloadFixture {
	t.Helper()
	checksum := sha256Hex(content)
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := []byte(`{"version":"` + manifestVersion + `","asset":"chatserver.exe","sha256":"` + checksum + `"}`)
	return &windowsDownloadFixture{
		updater:           u,
		key:               key,
		content:           content,
		checksumLine:      checksum + "  chatserver.exe\n",
		signature:         signTestAsset(t, key, content),
		manifest:          manifest,
		manifestSignature: signTestAsset(t, key, manifest),
		dest:              t.TempDir() + "/chatserver.exe",
	}
}

// serve starts the local release server, omitting the detached signature
// when withSignature is false, and routes the updater to it.
func (f *windowsDownloadFixture) serve(t *testing.T, withSignature bool) {
	t.Helper()
	assets := map[string][]byte{
		"chatserver.exe":                  f.content,
		"checksums.sha256":                []byte(f.checksumLine),
		"server-update-manifest.json":     f.manifest,
		"server-update-manifest.json.sig": f.manifestSignature,
	}
	if withSignature {
		assets["chatserver.exe.sig"] = f.signature
	}
	routeToServer(f.updater, serveDownloadAssets(t, assets))
}

// linuxDownloadFixture is the tar.gz counterpart: Linux has no detached
// binary signature, only the signed manifest, so the .sig slot is empty.
type linuxDownloadFixture struct {
	updater *Updater
	tgz     []byte
	dest    string
}

func newLinuxDownloadFixture(t *testing.T, inner []byte, checksumOverride string) *linuxDownloadFixture {
	t.Helper()
	tgz := mustBuildChatserverTarGz(t, inner)
	actual := sha256Hex(tgz)
	checksum := actual
	if checksumOverride != "" {
		checksum = checksumOverride
	}
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver-linux-amd64.tar.gz","sha256":"` + actual + `"}`)
	routeToServer(u, serveDownloadAssets(t, map[string][]byte{
		"chatserver-linux-amd64.tar.gz":     tgz,
		"checksums.sha256":                  []byte(checksum + "  linux/chatserver-linux-amd64.tar.gz\n"),
		"chatserver-linux-amd64.tar.gz.sig": nil,
		"server-update-manifest.json":       manifest,
		"server-update-manifest.json.sig":   signTestAsset(t, key, manifest),
	}))
	return &linuxDownloadFixture{updater: u, tgz: tgz, dest: t.TempDir() + "/chatserver"}
}

// newReleaseFor builds a complete release for tag whose URLs live under the
// real GitHub paths, so URL validation accepts them.
func newReleaseFor(tag, body string) ghRelease {
	return newTestRelease(tag, body, "https://github.com/J3vb/OwnCord/releases/tag/"+tag,
		"https://github.com/J3vb/OwnCord/releases/download/"+tag)
}

// newCountingUpdater serves a v2.0.0 release and reports how many times the
// updater hit the releases API.
func newCountingUpdater(t *testing.T) (*Updater, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	release := newReleaseFor("v2.0.0", "Major update")
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(release); err != nil {
			t.Errorf("encoding release: %v", err)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return newTestUpdater(srv.URL, "1.0.0"), &hits
}
