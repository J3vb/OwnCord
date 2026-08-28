package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func testHash(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

// multiAssetManifest mirrors the exact JSON the release workflow generates:
// legacy top-level fields bind the Windows binary (kept so already-deployed
// servers, which only understand the single-asset schema, can still verify)
// and the assets list binds every OS.
func multiAssetManifest(exeHash, linuxHash string) []byte {
	return fmt.Appendf(nil,
		`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"%s","assets":[{"asset":"chatserver.exe","sha256":"%s"},{"asset":"chatserver-linux-amd64.tar.gz","sha256":"%s"}]}`,
		exeHash, exeHash, linuxHash)
}

func TestVerifyReleaseManifest_MultiAssetSelectsLinuxEntry(t *testing.T) {
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := multiAssetManifest(testHash("exe"), testHash("linux"))
	sig := signTestAsset(t, key, manifest)

	got, err := u.VerifyReleaseManifest(manifest, sig, "v1.0.0", "chatserver-linux-amd64.tar.gz")
	if err != nil {
		t.Fatalf("VerifyReleaseManifest: %v", err)
	}
	if got.Asset != "chatserver-linux-amd64.tar.gz" || got.SHA256 != testHash("linux") {
		t.Errorf("resolved binding = {%s, %s}, want linux entry", got.Asset, got.SHA256)
	}
}

func TestVerifyReleaseManifest_MultiAssetSelectsWindowsEntry(t *testing.T) {
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := multiAssetManifest(testHash("exe"), testHash("linux"))
	sig := signTestAsset(t, key, manifest)

	got, err := u.VerifyReleaseManifest(manifest, sig, "v1.0.0", "chatserver.exe")
	if err != nil {
		t.Fatalf("VerifyReleaseManifest: %v", err)
	}
	if got.Asset != "chatserver.exe" || got.SHA256 != testHash("exe") {
		t.Errorf("resolved binding = {%s, %s}, want windows entry", got.Asset, got.SHA256)
	}
}

func TestVerifyReleaseManifest_MultiAssetUnknownAssetFails(t *testing.T) {
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := multiAssetManifest(testHash("exe"), testHash("linux"))
	sig := signTestAsset(t, key, manifest)

	if _, err := u.VerifyReleaseManifest(manifest, sig, "v1.0.0", "other.bin"); err == nil {
		t.Error("expected error for asset the manifest does not bind")
	}
}

func TestVerifyReleaseManifest_MultiAssetBadChecksumFails(t *testing.T) {
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := fmt.Appendf(nil,
		`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"%s","assets":[{"asset":"chatserver-linux-amd64.tar.gz","sha256":"not-a-hash"}]}`,
		testHash("exe"))
	sig := signTestAsset(t, key, manifest)

	if _, err := u.VerifyReleaseManifest(manifest, sig, "v1.0.0", "chatserver-linux-amd64.tar.gz"); err == nil {
		t.Error("expected error for invalid checksum in assets entry")
	}
}

func TestVerifyReleaseManifest_LegacySingleAssetStillVerifies(t *testing.T) {
	u, key := newSignedTestUpdater(t, "", "1.0.0")
	manifest := fmt.Appendf(nil,
		`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"%s"}`, testHash("exe"))
	sig := signTestAsset(t, key, manifest)

	got, err := u.VerifyReleaseManifest(manifest, sig, "v1.0.0", "chatserver.exe")
	if err != nil {
		t.Fatalf("VerifyReleaseManifest: %v", err)
	}
	if got.SHA256 != testHash("exe") {
		t.Errorf("SHA256 = %s, want legacy hash", got.SHA256)
	}
}

// TestReleaseManifest_Epoch1Shape pins the exact JSON field set of
// releaseManifest as of protocol epoch 1: top level {version, asset, sha256,
// assets}, with each assets[i] exactly {asset, sha256}. B2-3 adds a
// protocol-epoch field to this manifest; when it does, this test WILL fail
// until it is extended on purpose to include the new field in the expected
// shapes below.
func TestReleaseManifest_Epoch1Shape(t *testing.T) {
	full := releaseManifest{
		Version: "1.2.0",
		Asset:   "chatserver.exe",
		SHA256:  testHash("exe"),
		Assets: []releaseManifestAsset{
			{Asset: "chatserver.exe", SHA256: testHash("exe")},
			{Asset: "chatserver-linux-amd64.tar.gz", SHA256: testHash("linux")},
		},
	}
	data, err := json.Marshal(full)
	if err != nil {
		t.Fatalf("Marshal full manifest: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal full manifest: %v", err)
	}
	want := map[string]any{
		"version": "1.2.0",
		"asset":   "chatserver.exe",
		"sha256":  testHash("exe"),
		"assets": []any{
			map[string]any{"asset": "chatserver.exe", "sha256": testHash("exe")},
			map[string]any{"asset": "chatserver-linux-amd64.tar.gz", "sha256": testHash("linux")},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("full manifest JSON = %#v, want %#v — a new/renamed field must be added here deliberately", got, want)
	}

	// Assets == nil (legacy single-asset form) must omit "assets" entirely.
	legacy := releaseManifest{Version: "1.2.0", Asset: "chatserver.exe", SHA256: testHash("exe")}
	legacyData, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("Marshal legacy manifest: %v", err)
	}
	var gotLegacy map[string]any
	if err := json.Unmarshal(legacyData, &gotLegacy); err != nil {
		t.Fatalf("Unmarshal legacy manifest: %v", err)
	}
	if _, ok := gotLegacy["assets"]; ok {
		t.Errorf("legacy manifest JSON has an \"assets\" key = %v, want absent", gotLegacy["assets"])
	}
	wantLegacy := map[string]any{
		"version": "1.2.0",
		"asset":   "chatserver.exe",
		"sha256":  testHash("exe"),
	}
	if !reflect.DeepEqual(gotLegacy, wantLegacy) {
		t.Errorf("legacy manifest JSON = %#v, want %#v", gotLegacy, wantLegacy)
	}

	// A rename in either struct must break this: unmarshal a hand-written
	// legacy payload and assert the Go field values, not just presence.
	const legacyJSON = `{"version":"1.2.0","asset":"chatserver.exe","sha256":"deadbeef"}`
	var parsed releaseManifest
	if err := json.Unmarshal([]byte(legacyJSON), &parsed); err != nil {
		t.Fatalf("Unmarshal legacy JSON literal: %v", err)
	}
	wantParsed := releaseManifest{Version: "1.2.0", Asset: "chatserver.exe", SHA256: "deadbeef"}
	if !reflect.DeepEqual(parsed, wantParsed) {
		t.Errorf("parsed legacy manifest = %+v, want %+v", parsed, wantParsed)
	}
}
