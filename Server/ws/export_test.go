// export_test.go exposes unexported functions and methods for use in external
// test packages (package ws_test). This file is compiled only during "go test".
package ws

import (
	"encoding/json"
	"time"

	"github.com/owncord/server/db"
)

// BuildAuthOKForTest exposes Hub.buildAuthOK for external tests.
func (h *Hub) BuildAuthOKForTest(user *db.User, roleName string) []byte {
	return h.buildAuthOK(user, roleName)
}

// BuildReadyForTest exposes Hub.buildReady for external tests.
func (h *Hub) BuildReadyForTest(database *db.DB, userID int64) ([]byte, error) {
	return h.buildReady(database, userID)
}

// GetCachedSettingsForTest exposes Hub.getCachedSettings for external tests.
func (h *Hub) GetCachedSettingsForTest() (string, string) {
	return h.getCachedSettings()
}

// ExpireSettingsCacheForTest forces the settings cache to appear stale so that
// the next call to getCachedSettings triggers a DB refresh.
func (h *Hub) ExpireSettingsCacheForTest() {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	h.settingsLastUpdate = time.Time{} // zero time — always older than any TTL
}

// ParseChannelIDForTest exposes parseChannelID for external tests.
func ParseChannelIDForTest(payload json.RawMessage) (int64, error) {
	return parseChannelID(payload)
}

// BuildJSONForTest exposes buildJSON for external tests.
func BuildJSONForTest(v any) []byte {
	return buildJSON(v)
}

// ParseIdentityForTest exposes parseIdentity for external tests.
func ParseIdentityForTest(identity string) (int64, error) {
	return parseIdentity(identity)
}

// ParseRoomChannelIDForTest exposes parseRoomChannelID for external tests.
func ParseRoomChannelIDForTest(roomName string) (int64, error) {
	return parseRoomChannelID(roomName)
}

// WsToHTTPForTest exposes wsToHTTP for external tests.
func WsToHTTPForTest(wsURL string) string {
	return wsToHTTP(wsURL)
}
