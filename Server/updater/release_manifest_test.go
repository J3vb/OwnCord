package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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
