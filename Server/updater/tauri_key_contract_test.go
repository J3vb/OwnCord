package updater

// CONTRACT TEST. It reads an artifact owned by the Client component
// (Client/src-tauri/tauri.conf.json) but asserts a Server constant, using the
// client value only as a reference — so placement stays here, in the package
// that owns the assertion, and only the file name has to declare the crossing.
// See docs/contributing.md#testing for the membership rule.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultServerSignaturePublicKey_DiffersFromTauriUpdaterKey(t *testing.T) {
	tauriConfigPath := filepath.Clean(filepath.Join("..", "..", "Client", "src-tauri", "tauri.conf.json"))
	raw, err := os.ReadFile(tauriConfigPath)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", tauriConfigPath, err)
	}

	var cfg struct {
		Plugins struct {
			Updater struct {
				PubKey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("Unmarshal tauri.conf.json: %v", err)
	}

	if cfg.Plugins.Updater.PubKey == defaultServerSignaturePublicKey {
		t.Fatalf("server updater signing key must differ from tauri.conf.json updater pubkey")
	}
}
