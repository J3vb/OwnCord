package updater

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// TestCheckForUpdate_RefusesOlderRelease proves that a fully-assetted release
// whose version is not strictly newer than the running one is never offered,
// so the refusal comes from the version comparison alone.
func TestCheckForUpdate_RefusesOlderRelease(t *testing.T) {
	tests := []struct {
		name        string
		current     string
		latestTag   string
		wantCurrent string
		wantAvail   bool
	}{
		{"older minor", "1.0.0", "v0.9.0", "v1.0.0", false},
		{"older patch", "1.0.1", "v1.0.0", "v1.0.1", false},
		{"prerelease of running version", "1.0.0", "v1.0.0-rc.1", "v1.0.0", false},
		{"older beta", "2.3.0-beta.2", "v2.3.0-beta.1", "v2.3.0-beta.2", false},
		{"same version", "1.0.0", "v1.0.0", "v1.0.0", false},
		{"non-semver tag", "1.0.0", "nightly", "v1.0.0", false},
		{"control newer patch", "1.0.0", "v1.0.1", "v1.0.0", true},
		{"control beta to its release", "2.3.0-beta.1", "v2.3.0", "v2.3.0-beta.1", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			release := newTestRelease(tt.latestTag, "notes", "https://github.com/J3vb/OwnCord/releases/tag/"+tt.latestTag,
				"https://github.com/J3vb/OwnCord/releases/download/"+tt.latestTag)
			srv := newTestServer(t, release, http.StatusOK)
			defer srv.Close()

			u := newTestUpdater(srv.URL, tt.current)
			info, err := u.CheckForUpdate(context.Background())
			if err != nil {
				t.Fatalf("CheckForUpdate: %v", err)
			}
			if !info.RequiredAssetsPresent {
				t.Fatal("RequiredAssetsPresent = false; the refusal must come from the version alone")
			}
			if info.UpdateAvailable != tt.wantAvail {
				t.Errorf("UpdateAvailable = %v, want %v", info.UpdateAvailable, tt.wantAvail)
			}
			if info.Current != tt.wantCurrent {
				t.Errorf("Current = %q, want %q", info.Current, tt.wantCurrent)
			}
			if want := "v" + strings.TrimPrefix(tt.latestTag, "v"); info.Latest != want {
				t.Errorf("Latest = %q, want %q", info.Latest, want)
			}
		})
	}
}
