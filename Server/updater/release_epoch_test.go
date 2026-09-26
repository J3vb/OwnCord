package updater

// release_epoch_test.go — ReleaseProtocolEpoch reads the protocol epoch a
// release's signed server-update manifest declares (B2-2). The client-update
// endpoint uses it to hold back a client release that speaks a newer wire
// than this server: the server upgrades first, the clients follow.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// manifestServer serves the manifest and its signature at the URLs the
// UpdateInfo under test points at.
func manifestServer(t *testing.T, manifest, sig []byte) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/m.json", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(manifest) })
	mux.HandleFunc("/m.json.sig", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(sig) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestReleaseProtocolEpoch(t *testing.T) {
	u, key := newSignedTestUpdater(t, "", "1.0.0")

	t.Run("signed manifest declares the epoch", func(t *testing.T) {
		manifest := []byte(`{"version":"v2.0.0","asset":"chatserver.exe","sha256":"` + testHash("exe") + `","protocol_epoch":2}`)
		srv := manifestServer(t, manifest, signTestAsset(t, key, manifest))
		info := UpdateInfo{Latest: "v2.0.0", ManifestURL: srv.URL + "/m.json", ManifestSignatureURL: srv.URL + "/m.json.sig"}

		got, err := u.ReleaseProtocolEpoch(context.Background(), info)
		if err != nil {
			t.Fatalf("ReleaseProtocolEpoch: %v", err)
		}
		if got != 2 {
			t.Fatalf("epoch = %d, want 2", got)
		}
	})

	t.Run("manifest without the field is epoch 0", func(t *testing.T) {
		manifest := []byte(`{"version":"v1.2.0","asset":"chatserver.exe","sha256":"` + testHash("exe") + `"}`)
		srv := manifestServer(t, manifest, signTestAsset(t, key, manifest))
		info := UpdateInfo{Latest: "v1.2.0", ManifestURL: srv.URL + "/m.json", ManifestSignatureURL: srv.URL + "/m.json.sig"}

		got, err := u.ReleaseProtocolEpoch(context.Background(), info)
		if err != nil || got != 0 {
			t.Fatalf("epoch, err = %d, %v; want 0, nil", got, err)
		}
	})

	t.Run("release without a manifest is epoch 0", func(t *testing.T) {
		got, err := u.ReleaseProtocolEpoch(context.Background(), UpdateInfo{Latest: "v1.0.0"})
		if err != nil || got != 0 {
			t.Fatalf("epoch, err = %d, %v; want 0, nil", got, err)
		}
	})

	t.Run("tampered manifest is an error", func(t *testing.T) {
		manifest := []byte(`{"version":"v2.0.0","asset":"chatserver.exe","sha256":"` + testHash("exe") + `","protocol_epoch":1}`)
		sig := signTestAsset(t, key, manifest)
		tampered := []byte(`{"version":"v2.0.0","asset":"chatserver.exe","sha256":"` + testHash("exe") + `","protocol_epoch":0}`)
		srv := manifestServer(t, tampered, sig)
		info := UpdateInfo{Latest: "v2.0.0", ManifestURL: srv.URL + "/m.json", ManifestSignatureURL: srv.URL + "/m.json.sig"}

		if _, err := u.ReleaseProtocolEpoch(context.Background(), info); err == nil {
			t.Fatal("ReleaseProtocolEpoch accepted a manifest whose signature does not match")
		}
	})
}
